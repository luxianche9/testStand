param([Parameter(Mandatory = $true)][string]$ServerRoot)

$ErrorActionPreference = 'Stop'

try {
  $resolvedServerRoot = [System.IO.Path]::GetFullPath($ServerRoot)
  $simRoot = [System.IO.Directory]::GetParent([System.IO.Directory]::GetParent($resolvedServerRoot).FullName).FullName
  $configPath = Join-Path $resolvedServerRoot 'server.json'
  $examplePath = Join-Path $resolvedServerRoot 'server.json.example'
  $runRoot = Join-Path $resolvedServerRoot 'run'
  $logRoot = Join-Path $resolvedServerRoot 'logs'
  $pidFile = Join-Path $runRoot 'server.pid'
  $pythonPath = Join-Path $simRoot '.venv\Scripts\python.exe'

  if (-not (Test-Path -LiteralPath $pythonPath)) { throw "Virtual environment not found. Run $simRoot\install.ps1 first." }
  if (-not (Test-Path -LiteralPath $configPath)) {
    if (-not (Test-Path -LiteralPath $examplePath)) { throw "server.json.example not found in $resolvedServerRoot" }
    Copy-Item -LiteralPath $examplePath -Destination $configPath
  }
  $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
  New-Item -ItemType Directory -Force -Path $runRoot, $logRoot | Out-Null

  if (Test-Path -LiteralPath $pidFile) {
    $savedPid = [int](Get-Content -Raw -LiteralPath $pidFile)
    if (Get-Process -Id $savedPid -ErrorAction SilentlyContinue) {
      [pscustomobject]@{ serverId = $config.serverId; state = 'Running'; pid = $savedPid; message = 'Already running' } | ConvertTo-Json -Compress
      exit 0
    }
    Remove-Item -LiteralPath $pidFile -Force
  }

  $occupied = Get-NetTCPConnection -LocalPort ([int]$config.port) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($occupied) { throw "Port $($config.port) is already used by process $($occupied.OwningProcess)" }

  $env:TESTFORGE_SIM_CONFIG = $configPath
  $env:TESTFORGE_SERVER_ID = [string]$config.serverId
  $env:TESTFORGE_HARDWARE_ID = [string]$config.hardwareId
  $env:TESTFORGE_HOST = [string]$config.host
  $env:TESTFORGE_PORT = [string]$config.port
  $env:TESTFORGE_MCP_TOKEN = [string]$config.token
  $env:TESTFORGE_SIM_STDOUT = Join-Path $logRoot 'server.out.log'
  $env:TESTFORGE_SIM_STDERR = Join-Path $logRoot 'server.err.log'
  $env:PYTHONUNBUFFERED = '1'
  $created = Start-Process -FilePath $pythonPath -ArgumentList @('-m', 'testforge_sim_hardware') `
    -WorkingDirectory $resolvedServerRoot -WindowStyle Hidden -PassThru
  Set-Content -LiteralPath $pidFile -Value $created.Id -Encoding ascii -NoNewline

  for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
    Start-Sleep -Milliseconds 250
    $listener = Get-NetTCPConnection -LocalPort ([int]$config.port) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
      Set-Content -LiteralPath $pidFile -Value $listener.OwningProcess -Encoding ascii -NoNewline
      [pscustomobject]@{ serverId = $config.serverId; state = 'Running'; pid = $listener.OwningProcess; listening = $true; message = 'MCP listener ready' } | ConvertTo-Json -Compress
      exit 0
    }
    if (-not (Get-Process -Id $created.Id -ErrorAction SilentlyContinue)) {
      Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
      $detail = Get-Content -LiteralPath (Join-Path $logRoot 'server.err.log') -Tail 10 -ErrorAction SilentlyContinue
      throw "MCP process exited before opening port $($config.port). $($detail -join ' ')"
    }
  }
  throw "MCP startup timed out waiting for port $($config.port); process left running for inspection"
} catch {
  [pscustomobject]@{ state = 'Stopped'; message = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
