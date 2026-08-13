param(
  [Parameter(Mandatory = $true)][string]$TemplateRoot,
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $TemplateRoot 'run\server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) {
  [pscustomobject]@{ state = 'Stopped'; message = 'Already stopped' } | ConvertTo-Json -Compress
  exit 0
}

$serverPid = [int](Get-Content -Raw -LiteralPath $pidFile)
$process = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if (-not $process) {
  Remove-Item -LiteralPath $pidFile -Force
  [pscustomobject]@{ state = 'Stopped'; message = 'Stale PID removed' } | ConvertTo-Json -Compress
  exit 0
}

$config = Get-Content -Raw -LiteralPath (Join-Path $TemplateRoot 'server.json') | ConvertFrom-Json
try {
  $response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($config.port)/admin/shutdown" -Headers @{ Authorization = "Bearer $($config.token)" } -TimeoutSec 10
} catch {
  [pscustomobject]@{ state = 'Running'; pid = $serverPid; safe = $false; message = "Safe shutdown request failed; process left running: $($_.Exception.Message)" } | ConvertTo-Json -Compress
  exit 1
}

if ($response.ok -ne $true) {
  $reason = if ($response.error.message) { [string]$response.error.message } else { 'Hardware safe-stop was rejected' }
  [pscustomobject]@{ state = 'Running'; pid = $serverPid; safe = $false; message = "$reason; process left running" } | ConvertTo-Json -Compress
  exit 1
}

$attempts = [Math]::Max(1, $TimeoutSeconds * 2)
for ($attempt = 0; $attempt -lt $attempts; $attempt++) {
  Start-Sleep -Milliseconds 500
  if (-not (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    [pscustomobject]@{ state = 'Stopped'; safe = $true; message = 'Safe shutdown complete' } | ConvertTo-Json -Compress
    exit 0
  }
}

[pscustomobject]@{ state = 'Running'; pid = $serverPid; safe = $true; message = 'Safe stop completed but process exit timed out; process left running' } | ConvertTo-Json -Compress
exit 1
