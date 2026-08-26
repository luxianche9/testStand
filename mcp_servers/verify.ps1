[CmdletBinding()]
param(
    [ValidateSet("all", "pci1710l", "pci1762", "pci6208v", "cp118u_i")]
    [string]$Server = "all"
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $scriptRoot "tools\invoke-remote-source.ps1") verify --server $Server
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
