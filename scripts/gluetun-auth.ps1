# Windows twin of gluetun-auth.sh: generates the Gluetun control-server API key, writes
# <CONFIG_ROOT>\gluetun\auth\config.toml and stores GLUETUN_API_KEY in docker\.env.
param([string]$ConfigRoot = '')
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repo 'docker\.env'
if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $repo 'docker\.env.example') $envFile }
$lines = Get-Content $envFile

if (-not $ConfigRoot) {
  $m = $lines | Where-Object { $_ -match '^CONFIG_ROOT=(.+)$' } | Select-Object -First 1
  if ($m) { $ConfigRoot = $Matches[1] } else { $ConfigRoot = Join-Path $repo 'docker\data' }
}

$existing = $lines | Where-Object { $_ -match '^GLUETUN_API_KEY=(.+)$' } | Select-Object -First 1
if ($existing) {
  $key = $Matches[1]
  Write-Host "Keeping existing GLUETUN_API_KEY from $envFile"
} else {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  if ($lines -match '^GLUETUN_API_KEY=') {
    $lines = $lines | ForEach-Object { if ($_ -match '^GLUETUN_API_KEY=') { "GLUETUN_API_KEY=$key" } else { $_ } }
  } else {
    $lines += "GLUETUN_API_KEY=$key"
  }
  Set-Content -Path $envFile -Value $lines -Encoding utf8
  Write-Host "Generated GLUETUN_API_KEY in $envFile"
}

$authDir = Join-Path $ConfigRoot 'gluetun\auth'
New-Item -ItemType Directory -Force $authDir | Out-Null
@"
# Written by scripts/gluetun-auth.ps1. Arclight reads status, public IP and the forwarded port.
[[roles]]
name = "arclight"
routes = ["GET /v1/publicip/ip", "GET /v1/vpn/status", "GET /v1/openvpn/status", "GET /v1/portforward", "GET /v1/openvpn/portforwarded"]
auth = "apikey"
apikey = "$key"
"@ | Set-Content -Path (Join-Path $authDir 'config.toml') -Encoding utf8
Write-Host "Wrote $(Join-Path $authDir 'config.toml')"
Write-Host "Restart the stack with: docker compose down; docker compose up -d"
