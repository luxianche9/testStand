param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
)

$ErrorActionPreference = "Stop"
$realHardwareRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$workspaceRoot = Split-Path -Parent $realHardwareRoot
$electron = Join-Path $workspaceRoot "hardwareHarness\apps\desktop\node_modules\electron\dist\electron.exe"
$entrypoint = Join-Path $realHardwareRoot "tools\remote-source.cjs"

if (-not (Test-Path -LiteralPath $electron)) {
    throw "Electron runtime not found at $electron. Run pnpm install in hardwareHarness first."
}

$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
try {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $processArguments = @("`"$entrypoint`"") + $Arguments
    $process = Start-Process -FilePath $electron -ArgumentList $processArguments -NoNewWindow -Wait -PassThru
    exit $process.ExitCode
}
finally {
    if ($null -ne $previousRunAsNode) {
        $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode
    }
}
