[CmdletBinding()]
param(
    # "all", "sdk" or an adapter directory name under adapters\ (e.g. pci6208v).
    [string]$Target = "all"
)

# Local tests only: the SDK suite plus each adapter's tests (which include the
# dry-run compliance suite). Nothing here talks to real hardware.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$known = @(Get-ChildItem -LiteralPath (Join-Path $root "adapters") -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "pyproject.toml") } |
    ForEach-Object { $_.Name })
if ($Target -notin @("all", "sdk") -and $Target -notin $known) {
    throw "Unknown target '$Target'. Use all, sdk or one of: $($known -join ', ')"
}
$paths = @(switch ($Target) {
    "all" { "sdk", "adapters" }
    "sdk" { "sdk" }
    default { "adapters\$Target" }
})

Push-Location -LiteralPath $root
try {
    & uv run pytest @paths -q -p no:cacheprovider
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if ($Target -ne "sdk") {
        $adapters = if ($Target -eq "all") { $known } else { @($Target) }
        foreach ($adapter in $adapters) {
            Write-Host "[check] hh_adapter_$adapter"
            & uv run python -m hardwareharness_device_sdk --adapter "hh_adapter_$adapter" --check --log-level warning
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
    }
}
finally {
    Pop-Location
}
