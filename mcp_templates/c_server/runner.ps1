$runtimeRoot = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime\powershell\runner.ps1')) { Join-Path $PSScriptRoot 'runtime' } else { Join-Path $PSScriptRoot '..\runtime' }
& (Join-Path $runtimeRoot 'powershell\runner.ps1') -TemplateRoot $PSScriptRoot @args
exit $LASTEXITCODE
