$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$config = Get-Content -Raw -LiteralPath (Join-Path $root 'server.json') | ConvertFrom-Json
$pidFile = Join-Path $root 'run\server.pid'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'run'), (Join-Path $root 'logs') | Out-Null
if (Test-Path -LiteralPath $pidFile) {
  $existingPid = [int](Get-Content -Raw -LiteralPath $pidFile)
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
    $existingListener = Get-NetTCPConnection -LocalPort ([int]$config.port) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    $reportedPid = if ($existingListener) { $existingListener.OwningProcess } else { $existingPid }
    Set-Content -LiteralPath $pidFile -Value $reportedPid -Encoding ascii -NoNewline
    [pscustomobject]@{ state = 'Running'; pid = $reportedPid; listening = [bool]$existingListener; message = 'Already running' } | ConvertTo-Json -Compress
    exit 0
  }
  Remove-Item -LiteralPath $pidFile -Force
}
$configPath = Join-Path $root 'server.json'
$pythonPath = Join-Path $root 'venv\Scripts\python.exe'
$stdoutPath = Join-Path $root 'logs\server.out.log'
$stderrPath = Join-Path $root 'logs\server.err.log'
$commandLine = "cmd.exe /d /s /c `"set HARDWAREHARNESS_SERVER_CONFIG=$configPath&& `"$pythonPath`" -m hardwareharness_device_sdk --adapter {{ADAPTER_MODULE}} 1>>`"$stdoutPath`" 2>>`"$stderrPath`"`""
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
if ($created.ReturnValue -ne 0) { throw "Win32_Process.Create failed: $($created.ReturnValue)" }
Set-Content -LiteralPath $pidFile -Value $created.ProcessId -Encoding ascii -NoNewline
for ($attempt = 0; $attempt -lt 120; $attempt++) {
  Start-Sleep -Milliseconds 500
  $listener = Get-NetTCPConnection -LocalPort ([int]$config.port) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    Set-Content -LiteralPath $pidFile -Value $listener.OwningProcess -Encoding ascii -NoNewline
    [pscustomobject]@{ state = 'Running'; pid = $listener.OwningProcess; listening = $true; message = 'MCP listener ready' } | ConvertTo-Json -Compress
    exit 0
  }
  if (-not (Get-Process -Id $created.ProcessId -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    $tail = (Get-Content -LiteralPath (Join-Path $root 'logs\server.err.log') -Tail 30 -ErrorAction SilentlyContinue) -join "`n"
    throw "MCP launcher exited during startup. $tail"
  }
}
Stop-Process -Id $created.ProcessId -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
throw "MCP startup timed out waiting for port $($config.port)"
