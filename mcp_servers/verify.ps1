[CmdletBinding()]
param(
    # "all" or a servers.json id; remote-source.cjs rejects unknown ids.
    [string]$Server = "all"
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $scriptRoot "tools\invoke-remote-source.ps1") verify --server $Server
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
