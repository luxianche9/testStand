[CmdletBinding()]
param(
    # computerId of the target computer in the terminal registry.
    [Parameter(Mandatory = $true)][string]$Computer,
    [Parameter(Mandatory = $true)][string]$ServerId,
    [Parameter(Mandatory = $true)][string]$HardwareId,
    # Adapter directory name under adapters\ (e.g. pci1762).
    [Parameter(Mandatory = $true)][string]$Adapter,
    [Parameter(Mandatory = $true)][int]$Port,

    # Install directory on the remote computer; default E:\<serverid lower>_server.
    [string]$Root,
    [string]$Label,
    # JSON file with adapter settings, used only when server.json is created.
    [string]$Settings,
    # First install only: the new server.json gets dryRun, so the service runs on simulated drivers.
    [switch]$DryRun,
    [switch]$NoAutostart,
    # The desktop app's user data; close the app first, both write the same registry.
    [string]$UserData = (Join-Path $env:APPDATA "HardwareHarness")
)

# Thin wrapper around the backend deploy pipeline (design 4.8.3). The same code runs behind
# the interface's deploy button and the Agent tool; this only exposes it on the command line.
$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path (Split-Path -Parent $scriptRoot) "HardwareHarness\python"
$arguments = @(
    "run", "--project", $backend, "python", "-m", "hardwareharness_backend.devices.deploy",
    "--source", $scriptRoot, "deploy",
    "--user-data", $UserData, "--computer", $Computer, "--server-id", $ServerId,
    "--hardware-id", $HardwareId, "--adapter", $Adapter, "--port", $Port
)
if ($Root) { $arguments += @("--root", $Root) }
if ($Label) { $arguments += @("--label", $Label) }
if ($Settings) { $arguments += @("--settings", (Resolve-Path -LiteralPath $Settings).Path) }
if ($DryRun) { $arguments += "--dry-run" }
if ($NoAutostart) { $arguments += "--no-autostart" }
& uv @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
