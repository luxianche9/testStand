param(
  # Register a boot-time scheduled task that runs start.ps1 (design 4.8.2). Pass -AutoStart:$false to remove it.
  [switch]$AutoStart = $true
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$build = Get-Content -Raw -LiteralPath (Join-Path $root 'build.json') | ConvertFrom-Json
$python = Join-Path $root 'venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  python -m venv (Join-Path $root 'venv')
  if ($LASTEXITCODE -ne 0) { throw "python -m venv failed with exit code $LASTEXITCODE" }
}
& $python -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"
if ($LASTEXITCODE -ne 0) { throw "hardwareharness-device-sdk requires Python >= 3.11 in $root\venv; recreate the venv with a newer Python" }

$wheels = Join-Path $root 'wheels'
$requirements = Join-Path $root 'requirements.txt'
& $python -m pip install --disable-pip-version-check --no-index --find-links $wheels -r $requirements
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Offline install from wheels\ failed (bundle targets Python $($build.pythonVersion)); retrying from the package index"
  & $python -m pip install --disable-pip-version-check --find-links $wheels -r $requirements
  if ($LASTEXITCODE -ne 0) { throw "Dependency install failed with exit code $LASTEXITCODE" }
}
# Local packages keep their version across builds, so force the bundled code in place.
$local = @($build.packages | ForEach-Object { Join-Path $wheels $_.wheel })
& $python -m pip install --disable-pip-version-check --no-index --no-deps --force-reinstall @local
if ($LASTEXITCODE -ne 0) { throw "Bundled package install failed with exit code $LASTEXITCODE" }

# --- identity: server.json (written by the terminal) wins over the build defaults; never copy the token --------
$configPath = Join-Path $root 'server.json'
$config = if (Test-Path -LiteralPath $configPath) { Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json } else { $null }
if (-not $config) { Write-Warning "server.json not found in $root; registering build.json identity without a port" }
$serverId = if ($config -and $config.serverId) { [string]$config.serverId } else { [string]$build.serverId }
$hardwareId = if ($config -and $config.hardwareId) { [string]$config.hardwareId } else { [string]$build.hardwareId }
$port = if ($config -and $config.port) { [int]$config.port } else { $null }
$adapterWheel = @($build.packages | Where-Object { $_.name -eq $build.adapterModule } | Select-Object -First 1)
$adapterVersion = if ($adapterWheel) { ([string]$adapterWheel[0].wheel).Split('-')[1] } else { $null }

# --- boot task (design 4.8.2): SYSTEM runs start.ps1 at startup; a failure only warns ---------------------------
$taskPath = '\HardwareHarness\'
$autoStartRegistered = $false
if ($AutoStart) {
  try {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $root `
      -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-Path $root 'start.ps1')`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $trigger.Delay = 'PT30S'
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    Register-ScheduledTask -TaskPath $taskPath -TaskName $serverId -Action $action -Trigger $trigger -Principal $principal `
      -Settings $settings -Description "HardwareHarness: start $serverId from $root at boot" -Force | Out-Null
    $autoStartRegistered = $true
  } catch {
    Write-Warning "Boot task not registered (needs an elevated session): $($_.Exception.Message)"
  }
} else {
  Unregister-ScheduledTask -TaskPath $taskPath -TaskName $serverId -Confirm:$false -ErrorAction SilentlyContinue
}

# --- registry C:\ProgramData\HardwareHarness\services.json (design 4.8.1): one entry per root, no tokens.
# The terminal serializes installs on one computer; the temporary file + move keeps readers from seeing a torn file.
$registryDir = Join-Path $env:ProgramData 'HardwareHarness'
$registry = Join-Path $registryDir 'services.json'
New-Item -ItemType Directory -Force -Path $registryDir | Out-Null
$services = @()
if (Test-Path -LiteralPath $registry) {
  $existing = Get-Content -Raw -LiteralPath $registry | ConvertFrom-Json
  $services = @($existing.services | Where-Object { $_ -and $_.root -ne $root -and $_.serverId -ne $serverId })
}
$services += [pscustomobject][ordered]@{
  serverId = $serverId; hardwareId = $hardwareId; adapter = [string]$build.adapterModule
  adapterVersion = $adapterVersion; root = $root; port = $port
  installedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
}
$document = [ordered]@{ formatVersion = 1; services = @($services) }
$temporary = "$registry.tmp"
[System.IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject $document -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath $temporary -Destination $registry -Force
[pscustomobject]@{ state = 'Installed'; serverId = $serverId; adapterVersion = $adapterVersion; autoStart = $autoStartRegistered; registry = $registry } | ConvertTo-Json -Compress
