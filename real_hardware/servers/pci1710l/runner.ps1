$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location -LiteralPath $root
$env:TESTFORGE_SERVER_CONFIG = Join-Path $root 'server.json'
$python = Join-Path $root 'venv\Scripts\python.exe'
& $python -m testforge_remote 1>> (Join-Path $root 'logs\server.out.log') 2>> (Join-Path $root 'logs\server.err.log')
