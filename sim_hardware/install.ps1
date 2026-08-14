$ErrorActionPreference = 'Stop'

try {
  $venvRoot = Join-Path $PSScriptRoot '.venv'
  $pythonPath = Join-Path $venvRoot 'Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $pythonPath)) {
    if (Get-Command python -ErrorAction SilentlyContinue) {
      & python -m venv $venvRoot
    } elseif (Get-Command py -ErrorAction SilentlyContinue) {
      & py -3 -m venv $venvRoot
    } else {
      throw 'Python 3 was not found on PATH'
    }
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create the virtual environment' }
  }

  & $pythonPath -m pip install -e $PSScriptRoot
  if ($LASTEXITCODE -ne 0) { throw 'Failed to install testforge-sim-hardware' }

  foreach ($serverName in @('analog_input', 'analog_output', 'serial')) {
    $serverRoot = Join-Path $PSScriptRoot "servers\$serverName"
    $configPath = Join-Path $serverRoot 'server.json'
    if (-not (Test-Path -LiteralPath $configPath)) {
      Copy-Item -LiteralPath (Join-Path $serverRoot 'server.json.example') -Destination $configPath
    }
  }

  [pscustomobject]@{ installed = $true; python = $pythonPath; message = 'Virtual hardware environment ready' } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ installed = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}

