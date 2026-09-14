[CmdletBinding()]
param(
    [string]$DocsRoot = 'E:\Project\learnSTM32\doc',
    [string]$FirmwareRoot = 'E:\Project\learnSTM32',
    [string]$ProbeSerial,
    [int]$Port = 8015
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$python = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    & py -3.12 -m venv (Join-Path $root '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Python venv creation failed' }
}
& $python -m pip install -e (Join-Path $root 'app')
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
$configPath = Join-Path $root 'server.json'
if (Test-Path -LiteralPath $configPath) { Write-Host 'Installed. Existing server.json preserved.'; exit 0 }
$pack = Get-ChildItem -LiteralPath $DocsRoot -Filter 'Keil.STM32F4xx_DFP.3.1.1.pack' -File -Recurse | Select-Object -First 1
if (-not $pack) { throw 'STM32F4xx 3.1.1 pack not found under DocsRoot' }
if (-not $ProbeSerial) {
    $detected = & $python -m pyocd json --probes | ConvertFrom-Json
    $matches = @($detected.boards | Where-Object { $_.vendor_name -match 'Embedfire' -and $_.product_name -match 'DAP' })
    if ($matches.Count -ne 1) { throw 'Connect one FireDAP or provide -ProbeSerial explicitly' }
    $ProbeSerial = $matches[0].unique_id
}
$tokenBytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($tokenBytes)
$manuals = Join-Path (Split-Path (Split-Path $root -Parent) -Parent) 'hardware-manuals\stm32-batianhu-v2'
$config = @{
    serverId='FIREDAP_MCP';hardwareId='LOCAL_MCP.FIREDAP_0';computerId='LOCAL_PC';host='127.0.0.1';port=$Port
    token=[Convert]::ToBase64String($tokenBytes);probeSerial=$ProbeSerial;frequencyHz=1000000;operationTimeoutSeconds=120
    packPath=$pack.FullName;firmwareRoots=@($FirmwareRoot,(Join-Path $root 'firmware'))
    jobDirectory=(Join-Path $root 'run\jobs');pinoutPath=(Join-Path $manuals 'firedap.pinout.json')
}
$config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding utf8
Write-Host 'Installed. Run start.ps1 and register-testforge.cjs. Token is kept in server.json.'
