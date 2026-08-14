& (Join-Path $PSScriptRoot '..\..\powershell\start-server.ps1') -ServerRoot $PSScriptRoot @args
exit $LASTEXITCODE

