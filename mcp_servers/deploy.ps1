[CmdletBinding()]
param(
    # "all" or a servers.json id; assemble.py and remote-source.cjs reject unknown ids.
    [string]$Server = "all",

    [switch]$SkipTests,

    # Deploy the existing dist\<id> bundle instead of re-assembling it from sdk\ and adapters\.
    [switch]$NoAssemble
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $NoAssemble) {
    Push-Location -LiteralPath $scriptRoot
    try {
        & uv run python tools\assemble.py $Server
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    finally { Pop-Location }
}
$arguments = @("deploy", "--server", $Server)
if ($SkipTests) { $arguments += "--skip-tests" }
& (Join-Path $scriptRoot "tools\invoke-remote-source.ps1") @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
