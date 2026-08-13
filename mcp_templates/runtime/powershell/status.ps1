param([Parameter(Mandatory = $true)][string]$TemplateRoot)

$pidFile = Join-Path $TemplateRoot 'run\server.pid'
$configPath = Join-Path $TemplateRoot 'server.json'
if (-not (Test-Path -LiteralPath $pidFile)) {
  [pscustomobject]@{ state = 'Stopped'; listening = $false; message = 'PID file not present' } | ConvertTo-Json -Compress
  exit 0
}

$serverPid = [int](Get-Content -Raw -LiteralPath $pidFile)
if (-not (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  [pscustomobject]@{ state = 'Stopped'; listening = $false; message = 'Process not found' } | ConvertTo-Json -Compress
  exit 0
}

if (-not (Test-Path -LiteralPath $configPath)) {
  [pscustomobject]@{ state = 'Running'; pid = $serverPid; listening = $false; message = 'Process running; server.json is missing' } | ConvertTo-Json -Compress
  exit 1
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$listener = Get-NetTCPConnection -LocalPort ([int]$config.port) -State Listen -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq $serverPid | Select-Object -First 1
$listening = [bool]$listener
[pscustomobject]@{ state = 'Running'; pid = $serverPid; listening = $listening; message = $(if ($listening) { 'MCP listener ready' } else { 'Process running; listener initializing' }) } | ConvertTo-Json -Compress
