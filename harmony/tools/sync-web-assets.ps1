# harmony/tools/sync-web-assets.ps1
# Copies the web build into the HAP rawfile, where AssetServer serves it over the virtual https origin.
#
# Counterpart of the Android shell's asset copy: there it lands in android/app/src/main/assets/www,
# here it lands in harmony/entry/src/main/resources/rawfile/www.
#
# Usage:
#   cd web; $env:ELECTRON_SKIP_BINARY_DOWNLOAD='1'; npm run build; cd ..
#   powershell -ExecutionPolicy Bypass -File tools/sync-web-assets.ps1
#
# Where the web build is looked for, in order:
#   1. -WebDist "<path to web\dist>"
#   2. a sibling: <parent of this project>\web\dist   (when harmony/ still sits inside folia-mobile/)
#   3. the first line of tools/web-dist-path.txt      (this checkout keeps the project outside
#      folia-mobile, so the path is recorded there instead of hardcoded: the file is UTF-8 and the
#      path contains CJK, which cannot be a literal in a BOM-free ASCII script)
#
# Sync only: the target directory is cleared first, so a stale hashed chunk from an earlier build
# can never survive into the package.
#
# NOTE: keep this file ASCII-only. Windows PowerShell reads .ps1 as ANSI unless it carries a BOM,
# and this repository's scripts are deliberately BOM-free (see android/tools/build-apk.ps1).
[CmdletBinding()]
param(
    [string]$WebDist = ''
)

$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $PSScriptRoot
$target = Join-Path $projectDir 'entry\src\main\resources\rawfile\www'

if (-not $WebDist) {
    $sibling = Join-Path (Split-Path -Parent $projectDir) 'web\dist'
    if (Test-Path $sibling) {
        $WebDist = $sibling
    }
}

if (-not $WebDist) {
    $pointer = Join-Path $PSScriptRoot 'web-dist-path.txt'
    if (Test-Path $pointer) {
        $recorded = (Get-Content $pointer -Encoding UTF8 -TotalCount 1)
        if ($recorded) {
            $recorded = $recorded.Trim()
        }
        if ($recorded -and (Test-Path $recorded)) {
            $WebDist = $recorded
        }
    }
}

if (-not $WebDist) {
    throw @'
web build not found. Either build it (cd web; npm run build) next to this project, or pass the
path explicitly, or record it once in tools/web-dist-path.txt (one line, UTF-8):
  powershell -ExecutionPolicy Bypass -File tools/sync-web-assets.ps1 -WebDist "D:\path\to\web\dist"
'@
}

$source = $WebDist
if (-not (Test-Path (Join-Path $source 'index.html'))) {
    throw "web build has no index.html: $source"
}

if (Test-Path $target) {
    Remove-Item -Recurse -Force $target
}
New-Item -ItemType Directory -Force -Path $target | Out-Null

# Offline is structural inside the shell (the build lives in the HAP), so a service worker has
# nothing to do here - and a stale precached index.html referencing old hashed chunks was what
# once produced a black screen in the Android shell. See web/src/index.tsx.
$exclude = @('sw.js', 'workbox-*.js', 'registerSW.js')

Get-ChildItem -Path $source -Recurse -File | Where-Object {
    $name = $_.Name
    $skip = $false
    foreach ($pattern in $exclude) {
        if ($name -like $pattern) { $skip = $true; break }
    }
    -not $skip
} | ForEach-Object {
    $relative = $_.FullName.Substring($source.Length).TrimStart('\', '/')
    $destination = Join-Path $target $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}

$files = @(Get-ChildItem -Path $target -Recurse -File)
$bytes = ($files | Measure-Object -Property Length -Sum).Sum
Write-Host ("rawfile/www synced: {0} files, {1:N1} MB" -f $files.Count, ($bytes / 1MB))
Write-Host "Source: $source"
Write-Host "Next: build with tools/build-hap.ps1, or Run from DevEco Studio."
