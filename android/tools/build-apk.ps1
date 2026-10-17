# Folia Mobile shell - build the APK with the project-local toolchain.
#
# The toolchain lives outside the repository (in an ASCII-only path) because local.properties is
# ISO-8859-1 and the project path contains non-ASCII characters.
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools\build-apk.ps1 [-Variant debug|release] [-SkipAssets] [-NoArchive]
#
# Every release build is copied into ../builds/<version>-vc<code>-<timestamp>/ together with the shell
# sources and the web commit it came from (tools/archive-build.ps1). The build output path is reused by
# every build, so without that step the previous APK is gone as soon as the next one compiles.

param(
    [ValidateSet('debug', 'release')]
    [string]$Variant = 'debug',
    [switch]$SkipAssets,
    [switch]$NoArchive
)

$ErrorActionPreference = 'Stop'

# Toolchain resolution. FOLIA_TOOLCHAIN points at a portable JDK + Gradle + Android SDK laid out
# as jdk/ gradle/ sdk/ (how this project is built locally, in an ASCII-only path because AGP
# refuses non-ASCII project paths). Without it the script falls back to whatever JDK and SDK are
# already on the machine, so it stays usable elsewhere instead of hardcoding one machine's paths.
$toolchain = $env:FOLIA_TOOLCHAIN
if ($toolchain -and (Test-Path -LiteralPath $toolchain)) {
    $env:JAVA_HOME = Join-Path $toolchain 'jdk'
    $env:ANDROID_HOME = Join-Path $toolchain 'sdk'
    $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
    $gradle = Join-Path $toolchain 'gradle\bin\gradle.bat'
} else {
    if (-not $env:ANDROID_HOME -and $env:ANDROID_SDK_ROOT) { $env:ANDROID_HOME = $env:ANDROID_SDK_ROOT }
    $gradleOnPath = Get-Command gradle -ErrorAction SilentlyContinue
    if (-not $gradleOnPath) {
        throw 'No toolchain found. Set FOLIA_TOOLCHAIN to a jdk/gradle/sdk layout, or install Gradle and set JAVA_HOME + ANDROID_HOME.'
    }
    $gradle = $gradleOnPath.Source
}
if (-not $env:JAVA_HOME) { throw 'Set JAVA_HOME (JDK 17) or FOLIA_TOOLCHAIN.' }
if (-not $env:ANDROID_HOME) { throw 'Set ANDROID_HOME (Android SDK 35) or FOLIA_TOOLCHAIN.' }

# Force English diagnostics. On a zh-CN Windows host javac and Gradle emit GBK-encoded messages
# that the console codepage renders as mojibake, which makes a compile error unreadable exactly
# when it matters most.
$env:JAVA_TOOL_OPTIONS = '-Duser.language=en -Duser.country=US'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path

foreach ($required in @($gradle, (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Missing toolchain component: $required"
    }
}

if (-not $SkipAssets) {
    & (Join-Path $PSScriptRoot 'sync-web-assets.ps1')
}

$task = if ($Variant -eq 'release') { 'assembleRelease' } else { 'assembleDebug' }

Write-Host "Building $task"
& $gradle -p $project $task
if ($LASTEXITCODE -ne 0) {
    throw "Gradle failed with exit code $LASTEXITCODE"
}

$apkDir = Join-Path $project "app\build\outputs\apk\$Variant"
$apk = Get-ChildItem -LiteralPath $apkDir -Filter '*.apk' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1

if ($apk) {
    $sizeMb = [math]::Round($apk.Length / 1MB, 1)
    Write-Host ""
    Write-Host ("APK: {0}" -f $apk.FullName)
    Write-Host ("Size: {0} MB" -f $sizeMb)

    # Release builds are the distributable artefact, so they get a restore point automatically.
    # Debug builds are disposable and 2 MB larger; pass -NoArchive for a throwaway release build.
    #
    # The archiver lives at tools/archive-build.ps1 in the maintainer's checkout and is NOT part of
    # the public repository (that tree only carries web/, android/ and patches/). Archiving is a
    # maintainer workflow, not a requirement for building, so its absence is a note and not an error
    # - a fresh clone of the public repo must be able to run this script as-is.
    $archiver = Join-Path $PSScriptRoot '..\..\tools\archive-build.ps1'
    if ($Variant -eq 'release' -and -not $NoArchive -and -not (Test-Path -LiteralPath $archiver)) {
        Write-Host ''
        Write-Host "Skipping the build archive: tools\archive-build.ps1 is not present in this checkout."
    }
    if ($Variant -eq 'release' -and -not $NoArchive -and (Test-Path -LiteralPath $archiver)) {
        $gradleFile = Get-Content -LiteralPath (Join-Path $project 'app\build.gradle') -Raw
        $codeMatch = [regex]::Match($gradleFile, 'versionCode\s+(\d+)')
        $nameMatch = [regex]::Match($gradleFile, "versionName\s+'([^']+)'")
        if (-not $codeMatch.Success -or -not $nameMatch.Success) {
            throw 'Could not read versionCode / versionName out of app/build.gradle; refusing to build without a restorable version stamp.'
        }
        & $archiver `
            -ApkPath $apk.FullName `
            -VersionCode $codeMatch.Groups[1].Value `
            -VersionName $nameMatch.Groups[1].Value
        if ($LASTEXITCODE -ne 0) { throw "Archiving the build failed with exit code $LASTEXITCODE" }
    }
} else {
    Write-Warning "No APK found under $apkDir"
}
