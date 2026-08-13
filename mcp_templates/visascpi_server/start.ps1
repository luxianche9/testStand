$runtimeRoot = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime\powershell\start.ps1')) { Join-Path $PSScriptRoot 'runtime' } else { Join-Path $PSScriptRoot '..\runtime' }
& (Join-Path $runtimeRoot 'powershell\start.ps1') -TemplateRoot $PSScriptRoot -RuntimeRoot $runtimeRoot @args
exit $LASTEXITCODE
