param([Parameter(Mandatory = $true)][ValidateSet('start', 'status', 'stop')][string]$Action)

$ErrorActionPreference = 'Stop'
$simRoot = [System.IO.Directory]::GetParent($PSScriptRoot).FullName
$serverNames = @('analog_input', 'analog_output', 'serial')
$results = @()
$failed = $false

foreach ($serverName in $serverNames) {
  $scriptPath = Join-Path $simRoot "servers\$serverName\$Action.ps1"
  $raw = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath
  $exitCode = $LASTEXITCODE
  try {
    $parsed = ($raw -join [Environment]::NewLine) | ConvertFrom-Json
    $results += $parsed
  } catch {
    $results += [pscustomobject]@{ serverId = $serverName; state = 'Unknown'; message = ($raw -join ' ') }
  }
  if ($exitCode -ne 0) { $failed = $true }
}

ConvertTo-Json -InputObject @($results) -Depth 6
if ($failed) { exit 1 }

