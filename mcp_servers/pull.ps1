[CmdletBinding()]
param(
    [ValidateSet("all", "pci1710l", "pci1762", "pci6208v", "cp118u_i")]
    [string]$Server = "all",

    [switch]$Force
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$arguments = @("pull", "--server", $Server)
if ($Force) { $arguments += "--force" }
& (Join-Path $scriptRoot "tools\invoke-remote-source.ps1") @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
