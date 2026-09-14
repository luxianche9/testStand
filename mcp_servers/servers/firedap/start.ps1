[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
try { $config = Get-Content -LiteralPath (Join-Path $root 'server.json') -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Cannot read FireDAP configuration as UTF-8 JSON; check server.json without displaying its token' }
$healthUrl = "http://127.0.0.1:$($config.port)/health"
try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    if ($health.serverId -eq $config.serverId -and $health.serviceReady) { @{state='running';serverId=$config.serverId} | ConvertTo-Json -Compress; exit 0 }
    throw 'The configured port is occupied by another or draining service'
} catch {
    if ($_.Exception.Message -like '*occupied*') { throw }
}
New-Item -ItemType Directory -Force -Path (Join-Path $root 'run'),(Join-Path $root 'logs') | Out-Null
$python = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Run install.ps1 first' }
$configArgument = '"' + (Join-Path $root 'server.json') + '"'
$process = Start-Process -FilePath $python -ArgumentList '-m','hardwareharness_firedap','--config',$configArgument -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root 'logs\server.stdout.log') -RedirectStandardError (Join-Path $root 'logs\server.stderr.log')
$record = @{pid=$process.Id;startedAt=$process.StartTime.ToUniversalTime().ToString('o');python=$python}
$record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'run\process.json') -Encoding utf8
for ($attempt=0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    if ($process.HasExited) { throw 'FireDAP service exited; see logs/server.stderr.log' }
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        if ($health.serverId -eq $config.serverId -and $health.serviceReady) { @{state='running';pid=$process.Id;serverId=$config.serverId} | ConvertTo-Json -Compress; exit 0 }
    } catch { }
}
throw 'FireDAP service did not become ready; inspect logs'
