[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Project,

    [string]$Log
)

$ErrorActionPreference = 'Stop'

function Find-Uv4 {
    $candidates = @()
    $command = Get-Command UV4.exe -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }
    foreach ($key in @(
        'HKLM:\SOFTWARE\WOW6432Node\Keil\Products\MDK',
        'HKLM:\SOFTWARE\Keil\Products\MDK',
        'HKCU:\SOFTWARE\Keil\Products\MDK'
    )) {
        if (Test-Path -LiteralPath $key) {
            $item = Get-ItemProperty -LiteralPath $key
            foreach ($property in @('Path', 'InstallPath', 'Folder')) {
                if ($item.$property) {
                    $candidates += (Join-Path $item.$property 'UV4\UV4.exe')
                    $candidates += (Join-Path $item.$property 'UV4.exe')
                }
            }
        }
    }
    $candidates += @('D:\keil_v5\UV4\UV4.exe', 'C:\Keil_v5\UV4\UV4.exe', 'C:\Keil\UV4\UV4.exe')
    foreach ($candidate in $candidates | Select-Object -Unique) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

$projectPath = (Resolve-Path -LiteralPath $Project -ErrorAction Stop).Path
if ([System.IO.Path]::GetExtension($projectPath) -ne '.uvprojx') {
    throw 'Project must be a .uvprojx file.'
}
$projectDirectory = Split-Path -Parent $projectPath
$uv4 = Find-Uv4
if (-not $uv4) { throw 'UV4.exe was not found. Run check_environment.ps1 for details.' }

if ($Log) {
    $logPath = [System.IO.Path]::GetFullPath($Log)
} else {
    $logPath = Join-Path $projectDirectory 'build_log.txt'
}
$logDirectory = Split-Path -Parent $logPath
if (-not (Test-Path -LiteralPath $logDirectory)) {
    New-Item -ItemType Directory -Path $logDirectory | Out-Null
}
if (Test-Path -LiteralPath $logPath) { Remove-Item -LiteralPath $logPath -Force }

$started = Get-Date
$process = Start-Process -FilePath $uv4 -ArgumentList @('-b', $projectPath, '-j0', '-o', $logPath) -WorkingDirectory $projectDirectory -Wait -PassThru
if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) {
    throw "Keil did not create the build log (exit code $($process.ExitCode)): $logPath"
}
$logText = Get-Content -LiteralPath $logPath -Raw
$zeroErrors = $logText -match '(?im)0\s+Error\(s\)' -or $logText -match '(?im)0\s+Errors?'
$errorSummary = [regex]::Match($logText, '(?im)^.*\b\d+\s+Error\(s\).*$', 'Multiline').Value
$outputs = @(Get-ChildItem -LiteralPath (Split-Path -Parent $projectDirectory) -Recurse -File -Include '*.axf','*.hex' -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -ge $started.AddSeconds(-2) })
$hasAxf = [bool]($outputs | Where-Object Extension -eq '.axf')
$hasHex = [bool]($outputs | Where-Object Extension -eq '.hex')

[ordered]@{
    uv4 = $uv4
    project = $projectPath
    log = $logPath
    process_exit_code = $process.ExitCode
    zero_errors = $zeroErrors
    error_summary = $errorSummary
    outputs = @($outputs.FullName)
} | ConvertTo-Json -Depth 4

if (-not $zeroErrors) { exit 10 }
if (-not $hasAxf -or -not $hasHex) { exit 11 }
exit 0
