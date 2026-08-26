[CmdletBinding()]
param(
    [ValidateSet("all", "pci1710l", "pci1762", "pci6208v", "cp118u_i")]
    [string]$Server = "all",

    [switch]$SkipTests,

    [switch]$ForceOccupied
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$arguments = @("deploy", "--server", $Server)
if ($SkipTests) { $arguments += "--skip-tests" }
if ($ForceOccupied) { $arguments += "--force-occupied" }
& (Join-Path $scriptRoot "tools\invoke-remote-source.ps1") @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
