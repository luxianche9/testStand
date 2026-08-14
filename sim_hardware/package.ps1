$ErrorActionPreference = 'Stop'

$packageScript = Join-Path $PSScriptRoot 'tools\package.py'
$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'

if (Test-Path -LiteralPath $venvPython) {
  & $venvPython $packageScript
  exit $LASTEXITCODE
}

$python = Get-Command python -ErrorAction SilentlyContinue
if ($null -ne $python) {
  & $python.Source $packageScript
  exit $LASTEXITCODE
}

$py = Get-Command py -ErrorAction SilentlyContinue
if ($null -ne $py) {
  & $py.Source -3 $packageScript
  exit $LASTEXITCODE
}

throw 'Python 3.10 or newer was not found. Run install.ps1 after installing Python.'
