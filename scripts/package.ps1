param(
  [ValidateSet("firefox", "chrome")]
  [string]$Target = "firefox"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
$out = Join-Path $dist $Target

if (Test-Path $out) {
  Remove-Item -LiteralPath $out -Recurse -Force
}

New-Item -ItemType Directory -Path $out | Out-Null

$files = @(
  "content.js",
  "content.css",
  "options.html",
  "options.css",
  "options.js",
  "README.md",
  "PRIVACY.md"
)

foreach ($file in $files) {
  Copy-Item -LiteralPath (Join-Path $root $file) -Destination $out
}

Copy-Item -LiteralPath (Join-Path $root "icons") -Destination $out -Recurse

if ($Target -eq "chrome") {
  Copy-Item -LiteralPath (Join-Path $root "manifest.chrome.json") -Destination (Join-Path $out "manifest.json")
} else {
  Copy-Item -LiteralPath (Join-Path $root "manifest.json") -Destination (Join-Path $out "manifest.json")
}

$zip = Join-Path $dist "twitch-vod-muted-skipper-$Target.zip"
if (Test-Path $zip) {
  Remove-Item -LiteralPath $zip -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $basePath = (Resolve-Path -LiteralPath $out).Path
  Get-ChildItem -LiteralPath $out -Recurse -File | ForEach-Object {
    $fullPath = $_.FullName
    $relativePath = $fullPath.Substring($basePath.Length).TrimStart("\", "/")
    $entryName = $relativePath -replace "\\", "/"
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $fullPath, $entryName) | Out-Null
  }
} finally {
  $archive.Dispose()
}

Write-Host "Created $zip"
