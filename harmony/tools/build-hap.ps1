#Requires -Version 5.1
<#
.SYNOPSIS
  Builds the HarmonyOS HAP from this project, without DevEco Studio's GUI.

.DESCRIPTION
  Two facts about hvigor force the shape of this script:

  1. hvigor REFUSES a project path that contains non-ASCII characters. This repository lives under
     "...\folia-mobile\harmony", so it cannot be built in place. The script mirrors the project to an
     ASCII working directory and builds there.

  2. The hvigor daemon inherits the environment of whichever process started it. If a daemon from an
     earlier run (or from DevEco) is still alive without JAVA_HOME, the packaging step fails with
     "spawn java ENOENT". The script stops stale daemons first; they are disposable.

  The result is an UNSIGNED hap. Installing it on a device needs a Huawei developer account and a
  signing profile - that is DevEco Studio -> File -> Project Structure -> Signing Configs. An unsigned
  hap is still useful: it proves the ArkTS compiles and packs.

  NOTE: the mirrored directory is a build workspace, not a source of truth. The script copies the
  project over it every run, so never edit files there. Edit in the repository.

.PARAMETER WorkDir
  ASCII build directory. Default: D:\folia-hap-src

.PARAMETER DevEcoDir
  DevEco Studio installation. Default: probed from PATH and the usual install locations.

.PARAMETER NoMirror
  Skip the copy step and build whatever is already in WorkDir (faster when only nothing changed).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File harmony\tools\build-hap.ps1
#>
[CmdletBinding()]
param(
    [string]$WorkDir = 'D:\folia-hap-src',
    [string]$DevEcoDir = '',
    [switch]$NoMirror
)

$ErrorActionPreference = 'Stop'

$toolsDir = $PSScriptRoot
$projectDir = Split-Path -Parent $toolsDir

# --- locate DevEco Studio -------------------------------------------------------------
if (-not $DevEcoDir) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Huawei\DevEco Studio'),
        'C:\Program Files\Huawei\DevEco Studio',
        'D:\Huawei\DevEco Studio'
    )
    $link = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Huawei\DevEco Studio.lnk'
    if (Test-Path $link) {
        try {
            $shell = New-Object -ComObject WScript.Shell
            $target = $shell.CreateShortcut($link).TargetPath
            if ($target) {
                $candidates = @((Split-Path -Parent (Split-Path -Parent $target))) + $candidates
            }
        } catch {
            # A missing shortcut COM object is not fatal: the fixed candidates still get tried.
        }
    }
    foreach ($candidate in $candidates) {
        if (Test-Path (Join-Path $candidate 'tools\hvigor\bin\hvigorw.bat')) {
            $DevEcoDir = $candidate
            break
        }
    }
}
if (-not $DevEcoDir) {
    throw 'DevEco Studio not found. Pass -DevEcoDir "X:\path\to\DevEco Studio".'
}

$hvigorw = Join-Path $DevEcoDir 'tools\hvigor\bin\hvigorw.bat'
$sdkDir = Join-Path $DevEcoDir 'sdk'
$nodeDir = Join-Path $DevEcoDir 'tools\node'
$jbrDir = Join-Path $DevEcoDir 'jbr'
foreach ($required in @($hvigorw, $sdkDir, $nodeDir, $jbrDir)) {
    if (-not (Test-Path $required)) {
        throw "Missing part of the toolchain: $required"
    }
}

Write-Host "DevEco Studio : $DevEcoDir"

# --- refuse non-ASCII project paths, or mirror out of one --------------------------------
#
# hvigor validates its own working directory and rejects anything outside
#   letters digits - _ . ( ) space @
# so a project under e.g. "D:\dhs\<CJK>\folia-mobile\harmony" cannot be built in place at all.
# With the project at an ASCII path (E:\huawei\harmony) this whole step is skipped and the build
# runs where the sources are - which is what DevEco Studio needs too.
$needsMirror = $projectDir -match '[^\x20-\x7E]'
if ($needsMirror) {
    if ($WorkDir -match '[^\x20-\x7E]') {
        throw "WorkDir must be ASCII (hvigor rejects non-ASCII project paths): $WorkDir"
    }
    if (-not $NoMirror) {
        New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
        $rc = Start-Process -FilePath 'robocopy.exe' -ArgumentList (@(
            "`"$projectDir`"", "`"$WorkDir`"", '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
            '/XD', "`"$(Join-Path $projectDir '.git')`"", "`"$(Join-Path $projectDir '.hvigor')`"",
            "`"$(Join-Path $projectDir 'build')`"", "`"$(Join-Path $projectDir 'oh_modules')`"",
            "`"$(Join-Path $projectDir 'entry\build')`"", "`"$(Join-Path $projectDir 'entry\oh_modules')`"",
            '/XF', 'build.log'
        ) -join ' ') -Wait -PassThru -NoNewWindow
        # robocopy: 0-7 are success codes, 8+ are real failures.
        if ($rc.ExitCode -ge 8) {
            throw "robocopy failed with exit code $($rc.ExitCode)"
        }
        Write-Host "Project path is not ASCII, mirrored to: $WorkDir"
    } else {
        Write-Host "Project path is not ASCII, mirror skipped: $WorkDir"
    }
    $buildDir = $WorkDir
} else {
    Write-Host "Build in place : $projectDir"
    $buildDir = $projectDir
}

# --- stop stale hvigor daemons ----------------------------------------------------------
# Stopping the daemons is not only about the environment: a live daemon inherits this process's
# stdout handle, so anything that pipes this script's output (a CI log, a wrapper `| Tee-Object`)
# waits for end-of-stream and hangs long after the build finished. Starting and ending with no
# daemon keeps that from ever happening, and costs about half a second per build.
function Stop-HvigorDaemons {
    $found = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'hvigor' }
    foreach ($daemon in $found) {
        Stop-Process -Id $daemon.ProcessId -Force -ErrorAction SilentlyContinue
    }
    return $found.Count
}

$stopped = Stop-HvigorDaemons
if ($stopped -gt 0) {
    Write-Host "Stopped $stopped hvigor daemon(s) so the new environment is picked up."
    Start-Sleep -Seconds 2
}

# --- build -------------------------------------------------------------------------------
$env:DEVECO_SDK_HOME = $sdkDir
$env:NODE_HOME = $nodeDir
$env:JAVA_HOME = $jbrDir
$env:PATH = "$jbrDir\bin;$nodeDir;$env:PATH"

$logPath = Join-Path $buildDir 'build.log'
Remove-Item $logPath -ErrorAction SilentlyContinue

# Redirection is done by cmd, not by PowerShell's -RedirectStandardOutput.
#
# Why: hvigor leaves a node daemon and a java daemon running, and both inherit whatever handles the
# build process opened. Start-Process -RedirectStandardOutput + -Wait deadlocks on that, because
# .NET's WaitForExit also waits for end-of-stream on the redirected pipes, and the daemons never
# close them -- a build that finished in 11 seconds hangs the script forever. Letting cmd own the
# file handle and waiting on cmd alone avoids the deadlock entirely.
$inner = '/c ""' + $hvigorw + '" --mode module -p product=default assembleHap > "' + $logPath + '" 2>&1"'
$process = Start-Process -FilePath 'cmd.exe' -ArgumentList $inner `
    -WorkingDirectory $buildDir -NoNewWindow -PassThru
# WaitForExit() (the .NET method) waits for cmd.exe itself. PowerShell's Start-Process -Wait has
# different semantics: it waits for the whole process TREE, and hvigor's daemons are part of it and
# never exit, so -Wait hangs on a perfectly good build.
$process.WaitForExit()
$code = 1
try {
    $code = [int]$process.ExitCode
} catch {
    # ExitCode is unavailable if the object lost its handle; report a failure rather than a false pass.
    Write-Host "Could not read the hvigor exit code: $($_.Exception.Message)" -ForegroundColor Yellow
}

$log = ''
if (Test-Path $logPath) {
    $log = Get-Content $logPath -Raw
}
$errorCount = ([regex]::Matches($log, 'Error Message:')).Count
if ($errorCount -gt 0) {
    Write-Host ''
    Write-Host "ArkTS / build errors: $errorCount" -ForegroundColor Red
    [regex]::Matches($log, 'Error Message: (.+?) At File: (\S+)') | ForEach-Object {
        Write-Host ("  " + $_.Groups[1].Value)
        Write-Host ("    @ " + $_.Groups[2].Value)
    }
}

$hap = Get-ChildItem (Join-Path $buildDir 'entry\build') -Recurse -Include '*.hap' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1

# Leave no daemon behind (see Stop-HvigorDaemons for why this also keeps a piping caller unblocked).
$null = Stop-HvigorDaemons

Write-Host ''
if ($code -ne 0 -or -not $hap) {
    Write-Host "BUILD FAILED (hvigor exit $code). Full log: $logPath" -ForegroundColor Red
    exit 1
}

Write-Host "BUILD SUCCESSFUL in $buildDir" -ForegroundColor Green
Write-Host ("HAP           : " + $hap.FullName)
Write-Host ("Size          : " + [math]::Round($hap.Length / 1MB, 2) + " MB")
Write-Host ("SHA-256       : " + (Get-FileHash $hap.FullName -Algorithm SHA256).Hash.ToLower())
Write-Host ''
Write-Host 'Unsigned. To install on a device, sign it in DevEco Studio (Signing Configs).'
exit 0
