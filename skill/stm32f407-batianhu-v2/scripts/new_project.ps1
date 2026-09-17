[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Destination,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')]
    [string]$ProjectName
)

$ErrorActionPreference = 'Stop'
$skillRoot = Split-Path -Parent $PSScriptRoot
$template = Join-Path $skillRoot 'assets\keil-hal-template'
if (-not (Test-Path -LiteralPath $template -PathType Container)) {
    throw "Template not found: $template"
}

$destinationFull = [System.IO.Path]::GetFullPath($Destination)
$root = [System.IO.Path]::GetPathRoot($destinationFull)
if ($destinationFull.TrimEnd('\') -eq $root.TrimEnd('\')) {
    throw 'Destination may not be a filesystem root.'
}
if ($destinationFull.TrimEnd('\') -eq $skillRoot.TrimEnd('\')) {
    throw 'Destination may not overwrite the skill directory.'
}

if (Test-Path -LiteralPath $destinationFull) {
    if (-not (Test-Path -LiteralPath $destinationFull -PathType Container)) {
        throw "Destination exists and is not a directory: $destinationFull"
    }
    if (Get-ChildItem -LiteralPath $destinationFull -Force | Select-Object -First 1) {
        throw "Destination must be empty: $destinationFull"
    }
} else {
    New-Item -ItemType Directory -Path $destinationFull | Out-Null
}

Copy-Item -Path (Join-Path $template '*') -Destination $destinationFull -Recurse -Force

$generatedDirectories = @('Objects', 'Listings', 'Output')
foreach ($directoryName in $generatedDirectories) {
    Get-ChildItem -LiteralPath $destinationFull -Directory -Recurse -Force |
        Where-Object { $_.Name -eq $directoryName } |
        ForEach-Object {
            $resolved = $_.FullName
            if (-not $resolved.StartsWith($destinationFull, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to remove path outside destination: $resolved"
            }
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
}

Get-ChildItem -LiteralPath $destinationFull -File -Recurse -Force |
    Where-Object { $_.Name -match '\.(uvoptx|uvguix\..+|build_log\.txt|htm|dep)$' } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }

$projectFiles = @(Get-ChildItem -LiteralPath $destinationFull -Filter '*.uvprojx' -File -Recurse)
if ($projectFiles.Count -ne 1) {
    throw "Expected exactly one .uvprojx in template, found $($projectFiles.Count)."
}

$projectFile = $projectFiles[0]
[xml]$projectXml = Get-Content -LiteralPath $projectFile.FullName -Raw
$targetNodes = @($projectXml.Project.Targets.Target)
if ($targetNodes.Count -eq 0) { throw 'No Keil target found in project.' }
foreach ($target in $targetNodes) {
    $target.TargetName = $ProjectName
    if ($target.TargetOption -and $target.TargetOption.TargetCommonOption) {
        $target.TargetOption.TargetCommonOption.OutputName = $ProjectName
    }
}

$newProjectPath = Join-Path $projectFile.DirectoryName ($ProjectName + '.uvprojx')
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$settings = [System.Xml.XmlWriterSettings]::new()
$settings.Encoding = $utf8NoBom
$settings.Indent = $true
$writer = [System.Xml.XmlWriter]::Create($newProjectPath, $settings)
try { $projectXml.Save($writer) } finally { $writer.Dispose() }
if ($projectFile.FullName -ne $newProjectPath) {
    Remove-Item -LiteralPath $projectFile.FullName -Force
}

[ordered]@{
    project = $newProjectPath
    name = $ProjectName
    destination = $destinationFull
    defaults = 'STM32F407ZGTx; HAL; ARMCC5; HSE 25 MHz; SYSCLK 168 MHz'
} | ConvertTo-Json
