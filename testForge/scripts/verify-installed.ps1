param([switch]$KeepInstall)

$ErrorActionPreference = 'Stop'
$workspace = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $workspace 'dist'))
$installTarget = [System.IO.Path]::GetFullPath((Join-Path $distRoot '安装 验收'))
if (-not $installTarget.StartsWith($distRoot + [System.IO.Path]::DirectorySeparatorChar)) {
  throw 'Installer acceptance path escaped the workspace dist directory'
}
$existing = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -eq 'TestForge' }
foreach ($entry in $existing) {
  if ($entry.InstallLocation.TrimEnd('\') -ne $installTarget.TrimEnd('\')) {
    throw "An existing TestForge installation must be preserved: $($entry.InstallLocation)"
  }
}
$installer = Join-Path $distRoot 'TestForge-0.1.0-windows-x64.exe'
$process = Start-Process -FilePath $installer -ArgumentList "/S /D=$installTarget" -WindowStyle Hidden -PassThru -Wait
if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
$originalAcl = Get-Acl -LiteralPath $installTarget
$originalExecutable = $env:TESTFORGE_DESKTOP_EXECUTABLE
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
  $env:TESTFORGE_DESKTOP_EXECUTABLE = Join-Path $installTarget 'TestForge.exe'
  Push-Location (Join-Path $workspace 'apps/desktop')
  try {
    & pnpm.cmd exec playwright test e2e/python-backend.spec.ts
    if ($LASTEXITCODE -ne 0) { throw 'Installed Electron acceptance failed' }
  } finally { Pop-Location }
} finally {
  Set-Acl -LiteralPath $installTarget -AclObject $originalAcl
  $env:TESTFORGE_DESKTOP_EXECUTABLE = $originalExecutable
  if (-not $KeepInstall) {
    $uninstaller = Join-Path $installTarget 'Uninstall TestForge.exe'
    if (Test-Path -LiteralPath $uninstaller) {
      $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
      if ($uninstallProcess.ExitCode -ne 0) { throw "Uninstall failed: $($uninstallProcess.ExitCode)" }
    }
  }
}
