$runtimeRoot = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime\powershell\install.ps1')) { Join-Path $PSScriptRoot 'runtime' } else { Join-Path $PSScriptRoot '..\runtime' }
& (Join-Path $runtimeRoot 'powershell\install.ps1') -TemplateRoot $PSScriptRoot -RuntimeRoot $runtimeRoot @args
exit $LASTEXITCODE
