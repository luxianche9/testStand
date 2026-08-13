param([Parameter(Mandatory = $true)][string]$TemplateRoot)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $TemplateRoot
New-Item -ItemType Directory -Force -Path (Join-Path $TemplateRoot 'logs') | Out-Null
$env:TESTFORGE_SERVER_CONFIG = Join-Path $TemplateRoot 'server.json'
$python = Join-Path $TemplateRoot 'venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw "Virtual environment not found. Run install.ps1 first." }
& $python -m testforge_server 1>> (Join-Path $TemplateRoot 'logs\server.out.log') 2>> (Join-Path $TemplateRoot 'logs\server.err.log')
exit $LASTEXITCODE
