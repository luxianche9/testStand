& (Join-Path $PSScriptRoot '..\..\powershell\stop-server.ps1') -ServerRoot $PSScriptRoot @args
exit $LASTEXITCODE

