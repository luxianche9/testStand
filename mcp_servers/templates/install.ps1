$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$build = Get-Content -Raw -LiteralPath (Join-Path $root 'build.json') | ConvertFrom-Json
$python = Join-Path $root 'venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  python -m venv (Join-Path $root 'venv')
  if ($LASTEXITCODE -ne 0) { throw "python -m venv failed with exit code $LASTEXITCODE" }
}
& $python -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"
if ($LASTEXITCODE -ne 0) { throw "hardwareharness-device-sdk requires Python >= 3.11 in $root\venv; recreate the venv with a newer Python" }

$wheels = Join-Path $root 'wheels'
$requirements = Join-Path $root 'requirements.txt'
& $python -m pip install --disable-pip-version-check --no-index --find-links $wheels -r $requirements
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Offline install from wheels\ failed (bundle targets Python $($build.pythonVersion)); retrying from the package index"
  & $python -m pip install --disable-pip-version-check --find-links $wheels -r $requirements
  if ($LASTEXITCODE -ne 0) { throw "Dependency install failed with exit code $LASTEXITCODE" }
}
# Local packages keep their version across builds, so force the bundled code in place.
$local = @($build.packages | ForEach-Object { Join-Path $wheels $_.wheel })
& $python -m pip install --disable-pip-version-check --no-index --no-deps --force-reinstall @local
if ($LASTEXITCODE -ne 0) { throw "Bundled package install failed with exit code $LASTEXITCODE" }
