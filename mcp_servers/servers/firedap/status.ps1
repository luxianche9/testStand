[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
try { $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'server.json') -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop } catch { throw 'Cannot read FireDAP configuration as UTF-8 JSON; check server.json without displaying its token' }
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($config.port)/health" -TimeoutSec 3
    if ($health.serverId -ne $config.serverId) { throw 'Port belongs to another service' }
    @{state='running';serverId=$config.serverId;busy=$health.busy;probePresent=$health.probePresent;draining=(-not $health.serviceReady)} | ConvertTo-Json -Compress
} catch { @{state='stopped';message=$_.Exception.Message} | ConvertTo-Json -Compress }
