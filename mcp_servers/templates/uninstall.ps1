$ErrorActionPreference = 'Stop'
# Removes this root's services.json entry and its boot task (design 4.8.1/4.8.3). The caller stops the server
# first (prepare_shutdown + stop.ps1) and afterwards backs up and deletes the directory; this script touches neither.
$root = $PSScriptRoot
$configPath = Join-Path $root 'server.json'
$buildPath = Join-Path $root 'build.json'
$serverId = $null
if (Test-Path -LiteralPath $configPath) { $serverId = [string](Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json).serverId }
if (-not $serverId -and (Test-Path -LiteralPath $buildPath)) { $serverId = [string](Get-Content -Raw -LiteralPath $buildPath | ConvertFrom-Json).serverId }

$taskPath = '\HardwareHarness\'
$taskRemoved = $false
if ($serverId -and (Get-ScheduledTask -TaskPath $taskPath -TaskName $serverId -ErrorAction SilentlyContinue)) {
  Unregister-ScheduledTask -TaskPath $taskPath -TaskName $serverId -Confirm:$false
  $taskRemoved = $true
}

$registry = Join-Path (Join-Path $env:ProgramData 'HardwareHarness') 'services.json'
$removed = 0
if (Test-Path -LiteralPath $registry) {
  $existing = Get-Content -Raw -LiteralPath $registry | ConvertFrom-Json
  $all = @($existing.services | Where-Object { $_ })
  $services = @($all | Where-Object { $_.root -ne $root })
  $removed = $all.Count - $services.Count
  $document = [ordered]@{ formatVersion = 1; services = @($services) }
  $temporary = "$registry.tmp"
  [System.IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject $document -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temporary -Destination $registry -Force
}
[pscustomobject]@{ state = 'Uninstalled'; serverId = $serverId; registryEntriesRemoved = $removed; bootTaskRemoved = $taskRemoved } | ConvertTo-Json -Compress
