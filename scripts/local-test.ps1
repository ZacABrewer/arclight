# Runs Media-Tron on this PC against an isolated test environment, so nothing touches the NAS.
#
#   .\scripts\local-test.ps1            build web + start api on http://localhost:17878
#   .\scripts\local-test.ps1 -NoBuild   skip the web build (api only picks up a previous build)
#   .\scripts\local-test.ps1 -Reset     wipe the test database/config first
#
# Everything lives under ..\test-env: config (SQLite, logs), tv, movies, downloads.
param(
  [switch]$NoBuild,
  [switch]$Reset,
  [int]$Port = 17878
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$env = Join-Path (Split-Path -Parent $repo) 'test-env'

foreach ($d in 'config', 'tv', 'movies', 'downloads', 'downloads\complete', 'downloads\incomplete') {
  New-Item -ItemType Directory -Force (Join-Path $env $d) | Out-Null
}
if ($Reset) {
  Get-ChildItem (Join-Path $env 'config') -Force | Remove-Item -Recurse -Force -Confirm:$false
  Write-Host "Reset test config."
}

if (-not $NoBuild) {
  Write-Host "Building web app..."
  pnpm --filter @media-tron/web build
  if (-not $?) { throw "web build failed" }
}

# Secrets (TMDB key etc.) live in test-env\.env, outside the repo.
$dotenv = Join-Path $env '.env'
if (Test-Path $dotenv) {
  Get-Content $dotenv | Where-Object { $_ -match '^\s*[A-Z_]+=' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    Set-Item -Path "env:$($k.Trim())" -Value $v.Trim()
  }
}

$env:MEDIATRON_CONFIG = Join-Path $env 'config'
$env:MEDIATRON_PORT = "$Port"
$env:MEDIATRON_HOST = '127.0.0.1'
$env:MEDIATRON_WEB_DIST = Join-Path $repo 'apps\web\dist'
$env:MEDIATRON_LOG_LEVEL = 'info'

Write-Host ""
Write-Host "Media-Tron test instance"
Write-Host "  UI/API     http://localhost:$Port"
Write-Host "  config     $env\config"
Write-Host "  tv         $env\tv"
Write-Host "  movies     $env\movies"
Write-Host "  downloads  $env\downloads"
Write-Host "Ctrl+C to stop."
Write-Host ""

Set-Location (Join-Path $repo 'apps\api')
node --import tsx src/index.ts
