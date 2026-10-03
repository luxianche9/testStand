[CmdletBinding()]
param(
    # Adapter directory name under mcp_servers\adapters\ (e.g. pci6208v).
    [Parameter(Mandatory = $true)]
    [string]$Adapter,
    # mcp_servers directory; defaults to the one in this repository.
    [string]$Root = ""
)

# Local review gate for a new or changed adapter: pytest + dry-run compliance
# (via mcp_servers\test.ps1), then a scan for unresolved TODO(new_device)
# markers. Never talks to real hardware.
$ErrorActionPreference = "Stop"
if (-not $Root) {
    $Root = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\..\..\mcp_servers"
}
$Root = (Resolve-Path -LiteralPath $Root).Path
$adapterDir = Join-Path $Root "adapters\$Adapter"
if (-not (Test-Path -LiteralPath (Join-Path $adapterDir "pyproject.toml"))) {
    throw "No adapter at $adapterDir"
}

& (Join-Path $Root "test.ps1") -Target $Adapter
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$todos = @(Get-ChildItem -LiteralPath $adapterDir -Recurse -File |
    Where-Object { $_.FullName -notmatch '\\(\.venv|build|dist|__pycache__|[^\\]+\.egg-info)\\' } |
    Select-String -SimpleMatch "TODO(new_device)")
if ($todos.Count -gt 0) {
    $todos | ForEach-Object { Write-Host ("{0}:{1}: {2}" -f $_.Path, $_.LineNumber, $_.Line.Trim()) }
    Write-Host "[fail] $($todos.Count) TODO(new_device) marker(s) remain in ${adapterDir}; resolve them from the manual."
    exit 1
}
Write-Host "[ok] $Adapter passes tests, compliance and the TODO scan."
