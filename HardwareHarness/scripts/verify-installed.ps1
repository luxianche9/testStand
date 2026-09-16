param([switch]$KeepInstall)

$ErrorActionPreference = 'Stop'
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $workspace 'dist'))
$installTarget = [System.IO.Path]::GetFullPath((Join-Path $distRoot '安装 验收'))
if (-not $installTarget.StartsWith($distRoot + [System.IO.Path]::DirectorySeparatorChar)) {
  throw 'Installer acceptance path escaped the workspace dist directory'
}
$existing = Get-ItemProperty @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*') -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -eq 'HardwareHarness' }
foreach ($entry in $existing) {
  if (-not $entry.InstallLocation -or $entry.InstallLocation.TrimEnd('\') -ne $installTarget.TrimEnd('\')) {
    throw "An existing HardwareHarness installation must be preserved: $($entry.InstallLocation)"
  }
}
$existingProcesses = Get-CimInstance Win32_Process -Filter "Name = 'HardwareHarness.exe'"
if ($existingProcesses) { throw 'An existing HardwareHarness process must be preserved' }
$installer = Join-Path $distRoot 'HardwareHarness-0.1.0-windows-x64.exe'
$process = Start-Process -FilePath $installer -ArgumentList "/S /D=$installTarget" -WindowStyle Hidden -PassThru -Wait
if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
$payloadReport = Join-Path $workspace 'output/packaging/backend-payload.json'
if (Test-Path -LiteralPath $payloadReport) {
  $payload = Get-Content -LiteralPath $payloadReport -Raw | ConvertFrom-Json
  $installedBackend = Join-Path $installTarget 'resources/backend'
  $installedFiles = @(Get-ChildItem -LiteralPath $installedBackend -Recurse -File)
  if ($installedFiles.Count -ne $payload.fileCount) { throw 'Installed backend file count differs' }
  foreach ($property in $payload.hashes.PSObject.Properties) {
    $installedFile = Join-Path $installedBackend $property.Name
    if ((Get-FileHash -LiteralPath $installedFile -Algorithm SHA256).Hash -ne $property.Value) {
      throw "Installed backend hash mismatch: $($property.Name)"
    }
  }
  Write-Output "Verified $($installedFiles.Count) installed backend file hashes"
}
$originalAcl = Get-Acl -LiteralPath $installTarget
$originalExecutable = $env:HARDWAREHARNESS_DESKTOP_EXECUTABLE
$originalSmokeExecutable = $env:HARDWAREHARNESS_SMOKE_EXECUTABLE
try {
  $testAcl = Get-Acl -LiteralPath $installTarget
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $denyWrite = New-Object System.Security.AccessControl.FileSystemAccessRule($identity,
    [System.Security.AccessControl.FileSystemRights]::Write,
    [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Deny)
  $testAcl.AddAccessRule($denyWrite)
  Set-Acl -LiteralPath $installTarget -AclObject $testAcl
  $writeDenied = $false
  try { [System.IO.File]::WriteAllText((Join-Path $installTarget 'write-probe.txt'), 'probe') }
  catch [System.UnauthorizedAccessException] { $writeDenied = $true }
  if (-not $writeDenied) { throw 'Installation write denial was not effective' }
  Write-Output 'Confirmed read-only installation in a Chinese and space-containing path'
  $env:HARDWAREHARNESS_DESKTOP_EXECUTABLE = Join-Path $installTarget 'HardwareHarness.exe'
  $env:HARDWAREHARNESS_SMOKE_EXECUTABLE = $env:HARDWAREHARNESS_DESKTOP_EXECUTABLE
  Push-Location (Join-Path $workspace 'apps/desktop')
  try {
    & pnpm.cmd exec playwright test e2e/python-backend.spec.ts
    if ($LASTEXITCODE -ne 0) { throw 'Installed Electron acceptance failed' }
    & node.exe scripts/smoke-packaged.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Installed desktop and Agent acceptance failed' }
  } finally { Pop-Location }
} finally {
  Set-Acl -LiteralPath $installTarget -AclObject $originalAcl
  $env:HARDWAREHARNESS_DESKTOP_EXECUTABLE = $originalExecutable
  $env:HARDWAREHARNESS_SMOKE_EXECUTABLE = $originalSmokeExecutable
  if (-not $KeepInstall) {
    $uninstaller = Join-Path $installTarget 'Uninstall HardwareHarness.exe'
    if (Test-Path -LiteralPath $uninstaller) {
      $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
      if ($uninstallProcess.ExitCode -ne 0) { throw "Uninstall failed: $($uninstallProcess.ExitCode)" }
    }
  }
}
