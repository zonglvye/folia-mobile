#Requires -Version 5.1
<#
.SYNOPSIS
  Runs the pure helpers inside HttpProxy.ets on Node, by transpiling them as plain TypeScript.

.DESCRIPTION
  There is no HarmonyOS toolchain here, so the ArkTS sources cannot be compiled. Most of what
  breaks in the shell proxy is not a compile error anyway: a missing percent-decode, a header name
  compared case-sensitively, a cookie pair that keeps its attributes. proxy-parsing.cases.js pins
  those behaviours, and this script makes them runnable in one command.

  It works because HttpProxy.ets is ordinary TypeScript once the '@kit.*' imports are removed: the
  helpers never touch http, webview or util. The '@kit' imports are stripped from a temporary copy
  (never from the repo file), tsc emits JavaScript despite the expected "cannot find namespace
  webview" errors, and the cases run against the emitted class.

  This checks helper behaviour only. API signatures, ArkTS strictness and the ArkWeb/ArkUI runtime
  all still need a real DevEco build.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File harmony\tools\check-ets-helpers.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$toolsDir = $PSScriptRoot
$harmonyDir = Split-Path -Parent $toolsDir
$repoDir = Split-Path -Parent $harmonyDir

$source = Join-Path $harmonyDir 'entry\src\main\ets\shell\HttpProxy.ets'
$cases = Join-Path $toolsDir 'proxy-parsing.cases.js'

# Where is the web build's node_modules (the repo that owns tsc)?
# This project may or may not still sit next to web/, so probe: sibling web/, then the
# tools/web-dist-path.txt pointer (which records ...\web\dist, i.e. ...\web).
$webDir = Join-Path $repoDir 'web'
if (-not (Test-Path (Join-Path $webDir 'node_modules\.bin\tsc.cmd'))) {
    $pointer = Join-Path $toolsDir 'web-dist-path.txt'
    if (Test-Path $pointer) {
        $recorded = (Get-Content $pointer -Encoding UTF8 -TotalCount 1)
        if ($recorded) {
            $recorded = $recorded.Trim()
        }
        if ($recorded) {
            $webDir = Split-Path -Parent $recorded
        }
    }
}
$tsc = Join-Path $webDir 'node_modules\.bin\tsc.cmd'

foreach ($required in @($source, $cases)) {
    if (-not (Test-Path $required)) {
        throw "Missing file: $required"
    }
}
if (-not (Test-Path $tsc)) {
    throw "tsc not found at $tsc - run 'npm install' in the web repository first, or fix tools/web-dist-path.txt."
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ('folia-harmony-helpers-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null

try {
    # Strip the '@kit' imports only from the temporary copy the compiler sees.
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $lines = [System.IO.File]::ReadAllText($source, [System.Text.Encoding]::UTF8) -split "`r?`n"
    $kept = $lines | Where-Object { $_ -notmatch '^import ' }
    $transpiled = Join-Path $work 'HttpProxy.ts'
    [System.IO.File]::WriteAllText($transpiled, ($kept -join "`n"), $utf8NoBom)

    $outDir = Join-Path $work 'out'
    # Type errors are expected and harmless here (no @kit declarations, no webview namespace).
    # tsc still emits JavaScript, so the exit code is deliberately not inspected.
    & $tsc --ignoreConfig --target ES2019 --module commonjs --outDir $outDir --skipLibCheck $transpiled 2>&1 | Out-Null

    $emitted = Join-Path $outDir 'HttpProxy.js'
    if (-not (Test-Path $emitted)) {
        throw "tsc produced no JavaScript at $emitted"
    }

    # Forward slashes: 'require' in a CommonJS script takes paths, not file:// URLs, and a
    # forward-slash Windows path needs no backslash escaping inside the -e string.
    $casesPath = $cases.Replace('\', '/')
    $emittedPath = $emitted.Replace('\', '/')
    $node = 'const cases = require(''' + $casesPath + ''');'
    $node += ' const mod = require(''' + $emittedPath + ''');'
    $node += ' process.exit(cases(mod.HttpProxy) ? 0 : 1);'

    & node -e $node
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        Write-Host ''
        Write-Host 'Helper cases failed.' -ForegroundColor Red
        exit $code
    }
    exit 0
}
finally {
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
