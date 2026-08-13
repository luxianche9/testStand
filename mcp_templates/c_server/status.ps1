$runtimeRoot = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime\powershell\status.ps1')) { Join-Path $PSScriptRoot 'runtime' } else { Join-Path $PSScriptRoot '..\runtime' }
& (Join-Path $runtimeRoot 'powershell\status.ps1') -TemplateRoot $PSScriptRoot @args
exit $LASTEXITCODE
