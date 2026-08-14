param(
  [double[]]$AnalogInputs,
  [string[]]$SerialInputs
)

$ErrorActionPreference = 'Stop'

function Ensure-Config([string]$ServerName) {
  $serverRoot = Join-Path $PSScriptRoot "servers\$ServerName"
  $configPath = Join-Path $serverRoot 'server.json'
  if (-not (Test-Path -LiteralPath $configPath)) {
    Copy-Item -LiteralPath (Join-Path $serverRoot 'server.json.example') -Destination $configPath
  }
  return $configPath
}

function Write-Utf8Json([string]$Path, [object]$Value) {
  $json = $Value | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
}

try {
  if ($null -eq $AnalogInputs -and $null -eq $SerialInputs) { throw 'Specify -AnalogInputs and/or -SerialInputs' }
  $changed = @()

  if ($null -ne $AnalogInputs) {
    if ($AnalogInputs.Count -ne 4) { throw 'AnalogInputs must contain exactly 4 values' }
    foreach ($value in $AnalogInputs) {
      if ([double]::IsNaN($value) -or [double]::IsInfinity($value) -or $value -lt -10.0 -or $value -gt 10.0) {
        throw 'Each analog input must be finite and between -10 and 10 V'
      }
    }
    $path = Ensure-Config 'analog_input'
    $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $path | ConvertFrom-Json
    $config.driver.values = @($AnalogInputs)
    Write-Utf8Json $path $config
    $changed += 'analog_input'
  }

  if ($null -ne $SerialInputs) {
    if ($SerialInputs.Count -ne 2) { throw 'SerialInputs must contain exactly 2 strings' }
    $path = Ensure-Config 'serial'
    $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $path | ConvertFrom-Json
    $config.driver.inputs = @($SerialInputs)
    Write-Utf8Json $path $config
    $changed += 'serial'
  }

  [pscustomobject]@{ configured = $true; changed = $changed; restartRequired = $true; message = 'Configuration saved; restart the affected Server(s)' } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ configured = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
