$root = $PSScriptRoot
$pidFile = Join-Path $root 'run\server.pid'
$config = Get-Content -Raw -LiteralPath (Join-Path $root 'server.json') | ConvertFrom-Json
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
$listening = [bool](Get-NetTCPConnection -LocalPort ([int]$config.port) -State Listen -ErrorAction SilentlyContinue)
[pscustomobject]@{ state = 'Running'; pid = $serverPid; listening = $listening; message = $(if ($listening) { 'MCP listener ready' } else { 'Process running; listener initializing' }) } | ConvertTo-Json -Compress
