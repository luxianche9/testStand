[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
try { $config = Get-Content -LiteralPath (Join-Path $root 'server.json') -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Cannot read FireDAP configuration as UTF-8 JSON; check server.json without displaying its token' }
$recordPath = Join-Path $root 'run\process.json'
if (-not (Test-Path -LiteralPath $recordPath)) { throw 'No process identity record; refusing to stop an unowned process' }
$record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
$process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if (-not $process) { @{state='stopped'} | ConvertTo-Json -Compress; exit 0 }
if ($process.Path -ne $record.python -or $process.StartTime.ToUniversalTime().Ticks -ne ([datetime]$record.startedAt).ToUniversalTime().Ticks) { throw 'Process identity changed; refusing to terminate reused PID' }
# Busy jobs cause HTTP 409. Never bypass that refusal, including during normal restart.
$result = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($config.port)/admin/shutdown" -Headers @{Authorization="Bearer $($config.token)"} -TimeoutSec 5
if (-not $result.ok) { throw 'Safe shutdown refused' }
if (-not $process.WaitForExit(10000)) { throw 'Service did not exit after safe shutdown; inspect logs before retrying' }
Remove-Item -LiteralPath $recordPath
@{state='stopped'} | ConvertTo-Json -Compress
