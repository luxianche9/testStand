param(
  [Parameter(Mandatory = $true)][string]$ServerRoot,
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
$resolvedServerRoot = [System.IO.Path]::GetFullPath($ServerRoot)
$configPath = Join-Path $resolvedServerRoot 'server.json'
$pidFile = Join-Path $resolvedServerRoot 'run\server.pid'
$serverId = Split-Path $resolvedServerRoot -Leaf

if (-not (Test-Path -LiteralPath $pidFile)) {
  [pscustomobject]@{ serverId = $serverId; state = 'Stopped'; message = 'Already stopped' } | ConvertTo-Json -Compress
  exit 0
}

$serverPid = [int](Get-Content -Raw -LiteralPath $pidFile)
$process = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if (-not $process) {
  Remove-Item -LiteralPath $pidFile -Force
  [pscustomobject]@{ serverId = $serverId; state = 'Stopped'; message = 'Stale PID removed' } | ConvertTo-Json -Compress
  exit 0
}

if (-not (Test-Path -LiteralPath $configPath)) {
  [pscustomobject]@{ serverId = $serverId; state = 'Running'; pid = $serverPid; safe = $false; message = 'server.json is missing; process left running' } | ConvertTo-Json -Compress
  exit 1
}

$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$serverId = [string]$config.serverId
try {
  $response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($config.port)/admin/shutdown" -Headers @{ Authorization = "Bearer $($config.token)" } -TimeoutSec 10
} catch {
  [pscustomobject]@{ serverId = $serverId; state = 'Running'; pid = $serverPid; safe = $false; message = "Safe shutdown failed; process left running: $($_.Exception.Message)" } | ConvertTo-Json -Compress
  exit 1
}

if ($response.ok -ne $true) {
  $reason = if ($response.error.message) { [string]$response.error.message } else { 'Virtual hardware safe-stop was rejected' }
  [pscustomobject]@{ serverId = $serverId; state = 'Running'; pid = $serverPid; safe = $false; message = "$reason; process left running" } | ConvertTo-Json -Compress
  exit 1
}

$attempts = [Math]::Max(1, $TimeoutSeconds * 4)
for ($attempt = 0; $attempt -lt $attempts; $attempt += 1) {
  Start-Sleep -Milliseconds 250
  if (-not (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    [pscustomobject]@{ serverId = $serverId; state = 'Stopped'; safe = $true; message = 'Safe shutdown complete' } | ConvertTo-Json -Compress
    exit 0
  }
}

[pscustomobject]@{ serverId = $serverId; state = 'Running'; pid = $serverPid; safe = $true; message = 'Safe stop completed but process exit timed out; process left running' } | ConvertTo-Json -Compress
exit 1
