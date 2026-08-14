& (Join-Path $PSScriptRoot '..\..\powershell\status-server.ps1') -ServerRoot $PSScriptRoot @args
exit $LASTEXITCODE

