# Folia Mobile shell - sync the built web app into the APK's assets.
#
# The shell ships the web build inside the APK, so this copy is what makes offline structural:
# nothing is fetched at runtime. /MIR keeps the asset tree an exact mirror of dist/, so a
# removed chunk cannot linger and be served by accident.
#
# Usage:  powershell -ExecutionPolicy Bypass -File tools\sync-web-assets.ps1 [-Dist <path>]

param(
    [string]$Dist = (Join-Path $PSScriptRoot '..\..\web\dist')
)

$ErrorActionPreference = 'Stop'

$dist = (Resolve-Path -LiteralPath $Dist).Path
$target = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\app\src\main\assets')).Path
$target = Join-Path $target 'www'

if (-not (Test-Path -LiteralPath (Join-Path $dist 'index.html'))) {
    throw "No index.html in $dist - run `npm run build` in the web project first."
}

Write-Host "Syncing web build -> APK assets"
Write-Host "  from: $dist"
Write-Host "  to  : $target"

$null = New-Item -ItemType Directory -Force -Path $target
# robocopy returns 0-7 for success; 8+ is a real failure.
$null = robocopy $dist $target /MIR /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed with exit code $LASTEXITCODE"
}

$files = Get-ChildItem -LiteralPath $target -Recurse -File
$totalMb = [math]::Round((($files | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host ("Done: {0} files, {1} MB" -f $files.Count, $totalMb)
