param(
  [Parameter(Mandatory = $true)][string]$TemplateRoot,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot
)

$ErrorActionPreference = 'Stop'
$python = Join-Path $TemplateRoot 'venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  & python -m venv (Join-Path $TemplateRoot 'venv')
  if ($LASTEXITCODE -ne 0) { throw "Failed to create the Python virtual environment" }
}

& $python -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip" }
& $python -m pip install -e $RuntimeRoot
if ($LASTEXITCODE -ne 0) { throw "Failed to install the TestForge MCP runtime" }
& $python -m pip install -e (Join-Path $TemplateRoot 'app')
if ($LASTEXITCODE -ne 0) { throw "Failed to install the hardware server application" }
