[CmdletBinding()]
param(
    [ValidateSet("all", "pci1710l", "pci1762", "pci6208v", "cp118u_i")]
    [string]$Server = "all"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceRoot = Split-Path -Parent $root
$pythonCandidates = @(
    (Join-Path $workspaceRoot "sim_hardware\.venv\Scripts\python.exe"),
    (Join-Path $workspaceRoot "sim_hardware\venv\Scripts\python.exe")
)
$python = $pythonCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $python) { throw "No local Python environment found under sim_hardware" }

$serverIds = if ($Server -eq "all") {
    @("pci1710l", "pci1762", "pci6208v", "cp118u_i")
} else {
    @($Server)
}

try {
    foreach ($serverId in $serverIds) {
        $serverRoot = Join-Path $root "servers\$serverId"
        $env:PYTHONPATH = Join-Path $serverRoot "app\src"
        $env:HARDWAREHARNESS_SERVER_CONFIG = Join-Path $serverRoot "server.example.json"
        Write-Host "[test] $serverId"
        & $python -m unittest discover -s (Join-Path $serverRoot "app\tests") -p "test_*.py"
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
}
finally {
    Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
    Remove-Item Env:HARDWAREHARNESS_SERVER_CONFIG -ErrorAction SilentlyContinue
}
