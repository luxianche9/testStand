[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$skillRoot = Split-Path -Parent $PSScriptRoot
$bundledPack = Join-Path $skillRoot 'assets\Keil.STM32F4xx_DFP.3.1.1.pack'

function Find-FirstExistingFile {
    param([string[]]$Candidates)
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

function Get-RegistryUv4Candidates {
    $keys = @(
        'HKLM:\SOFTWARE\WOW6432Node\Keil\Products\MDK',
        'HKLM:\SOFTWARE\Keil\Products\MDK',
        'HKCU:\SOFTWARE\Keil\Products\MDK'
    )
    $results = @()
    foreach ($key in $keys) {
        if (Test-Path -LiteralPath $key) {
            $item = Get-ItemProperty -LiteralPath $key
            foreach ($property in @('Path', 'InstallPath', 'Folder')) {
                $root = $item.$property
                if ($root) {
                    $results += (Join-Path $root 'UV4\UV4.exe')
                    $results += (Join-Path $root 'UV4.exe')
                }
            }
        }
    }
    return $results
}

$uv4Candidates = @()
$command = Get-Command UV4.exe -ErrorAction SilentlyContinue
if ($command) { $uv4Candidates += $command.Source }
$uv4Candidates += Get-RegistryUv4Candidates
$uv4Candidates += @(
    'D:\keil_v5\UV4\UV4.exe',
    'C:\Keil_v5\UV4\UV4.exe',
    'C:\Keil\UV4\UV4.exe'
)
$uv4 = Find-FirstExistingFile $uv4Candidates

$armccCandidates = @(
    'D:\keil_v5\ARM\ARMCC\bin\armcc.exe',
    'C:\Keil_v5\ARM\ARMCC\bin\armcc.exe',
    'C:\Keil\ARM\ARMCC\bin\armcc.exe'
)
if ($uv4) {
    $keilRoot = Split-Path -Parent (Split-Path -Parent $uv4)
    $armccCandidates = @((Join-Path $keilRoot 'ARM\ARMCC\bin\armcc.exe')) + $armccCandidates
}
$armcc = Find-FirstExistingFile $armccCandidates

$packRoots = @()
if ($env:LOCALAPPDATA) { $packRoots += (Join-Path $env:LOCALAPPDATA 'Arm\Packs') }
if ($uv4) {
    $keilRoot = Split-Path -Parent (Split-Path -Parent $uv4)
    $packRoots += (Join-Path $keilRoot 'ARM\PACK')
}
$packRoots += @('D:\keil_v5\ARM\PACK', 'C:\Keil_v5\ARM\PACK', 'C:\Keil\ARM\PACK')
$installedPack = $null
foreach ($root in $packRoots | Select-Object -Unique) {
    $candidate = Join-Path $root 'Keil\STM32F4xx_DFP\3.1.1'
    if (Test-Path -LiteralPath $candidate -PathType Container) {
        $installedPack = (Resolve-Path -LiteralPath $candidate).Path
        break
    }
}

$packHash = $null
$packHashMatches = $false
if (Test-Path -LiteralPath $bundledPack -PathType Leaf) {
    $packHash = (Get-FileHash -LiteralPath $bundledPack -Algorithm SHA256).Hash.ToLowerInvariant()
    $packHashMatches = $packHash -eq '345231106fe697df24bbe9133aeeec1b0383d7891c4adf4f47bbb8b478e9f2f0'
}

$result = [ordered]@{
    uv4 = $uv4
    armcc5 = $armcc
    dfp_3_1_1_installed = $installedPack
    bundled_pack = if (Test-Path -LiteralPath $bundledPack) { (Resolve-Path -LiteralPath $bundledPack).Path } else { $null }
    bundled_pack_sha256 = $packHash
    bundled_pack_hash_valid = $packHashMatches
    build_ready = [bool]($uv4 -and $armcc)
    note = 'Read-only check. This script never installs the bundled device pack.'
}

$result | ConvertTo-Json -Depth 3
if (-not $result.build_ready) { exit 2 }
if (-not $result.bundled_pack_hash_valid) { exit 3 }
exit 0
