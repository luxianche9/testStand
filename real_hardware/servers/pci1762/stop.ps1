$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pidFile = Join-Path $root 'run\server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) {
  [pscustomobject]@{ state = 'Stopped'; message = 'Already stopped' } | ConvertTo-Json -Compress
  exit 0
}
$config = Get-Content -Raw -LiteralPath (Join-Path $root 'server.json') | ConvertFrom-Json
$serverPid = [int](Get-Content -Raw -LiteralPath $pidFile)
$process = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if (-not $process) {
  Remove-Item -LiteralPath $pidFile -Force
  [pscustomobject]@{ state = 'Stopped'; message = 'Stale PID removed' } | ConvertTo-Json -Compress
  exit 0
}
try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($config.port)/admin/shutdown" -Headers @{ Authorization = "Bearer $($config.token)" } -TimeoutSec 10 | Out-Null } catch { }
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  Start-Sleep -Milliseconds 500
  if (-not (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    [pscustomobject]@{ state = 'Stopped'; message = 'Graceful shutdown complete' } | ConvertTo-Json -Compress
    exit 0
  }
}
Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
[pscustomobject]@{ state = 'Stopped'; message = 'Graceful timeout; process forced to stop' } | ConvertTo-Json -Compress
