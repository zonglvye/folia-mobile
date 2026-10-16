# Folia Mobile shell - build the APK with the project-local toolchain.
#
# The toolchain lives outside the repository (in an ASCII-only path) because local.properties is
# ISO-8859-1 and the project path contains non-ASCII characters.
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools\build-apk.ps1 [-Variant debug|release] [-SkipAssets]

param(
    [ValidateSet('debug', 'release')]
    [string]$Variant = 'debug',
    [switch]$SkipAssets
)

$ErrorActionPreference = 'Stop'

$toolchain = 'D:\folia-toolchain'
$env:JAVA_HOME = Join-Path $toolchain 'jdk'
$env:ANDROID_HOME = Join-Path $toolchain 'sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

$gradle = Join-Path $toolchain 'gradle\bin\gradle.bat'
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
} else {
    Write-Warning "No APK found under $apkDir"
}
