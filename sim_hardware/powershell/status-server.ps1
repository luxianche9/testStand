param([Parameter(Mandatory = $true)][string]$ServerRoot)

$ErrorActionPreference = 'Stop'
$resolvedServerRoot = [System.IO.Path]::GetFullPath($ServerRoot)
$configPath = Join-Path $resolvedServerRoot 'server.json'
$pidFile = Join-Path $resolvedServerRoot 'run\server.pid'
$serverId = Split-Path $resolvedServerRoot -Leaf

if (Test-Path -LiteralPath $configPath) {
  $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
  $serverId = [string]$config.serverId
}

if (-not (Test-Path -LiteralPath $pidFile)) {
  [pscustomobject]@{ serverId = $serverId; state = 'Stopped'; listening = $false; message = 'PID file not present' } | ConvertTo-Json -Compress
  exit 0
}

$serverPid = [int](Get-Content -Raw -LiteralPath $pidFile)
if (-not (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  [pscustomobject]@{ serverId = $serverId; state = 'Stopped'; listening = $false; message = 'Stale PID removed' } | ConvertTo-Json -Compress
  exit 0
}

if (-not (Test-Path -LiteralPath $configPath)) {
  [pscustomobject]@{ serverId = $serverId; state = 'Running'; pid = $serverPid; listening = $false; message = 'Process running; server.json is missing' } | ConvertTo-Json -Compress
  exit 1
}

$listener = Get-NetTCPConnection -LocalPort ([int]$config.port) -State Listen -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq $serverPid | Select-Object -First 1
$listening = [bool]$listener
[pscustomobject]@{
  serverId = $serverId
  state = 'Running'
  pid = $serverPid
  listening = $listening
  message = $(if ($listening) { 'MCP listener ready' } else { 'Process running; listener initializing' })
} | ConvertTo-Json -Compress
