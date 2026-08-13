$runtimeRoot = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime\powershell\stop.ps1')) { Join-Path $PSScriptRoot 'runtime' } else { Join-Path $PSScriptRoot '..\runtime' }
& (Join-Path $runtimeRoot 'powershell\stop.ps1') -TemplateRoot $PSScriptRoot @args
exit $LASTEXITCODE
