$ErrorActionPreference = 'Stop'

foreach ($serverName in @('analog_input', 'analog_output', 'serial')) {
  $serverRoot = Join-Path $PSScriptRoot "servers\$serverName"
  Copy-Item -LiteralPath (Join-Path $serverRoot 'server.json.example') -Destination (Join-Path $serverRoot 'server.json') -Force
}

[pscustomobject]@{ reset = $true; restartRequired = $true; message = 'Default virtual hardware configuration restored' } | ConvertTo-Json -Compress

