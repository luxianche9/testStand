param(
  [Parameter(Mandatory = $true)][string]$TemplateRoot,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot
)

$ErrorActionPreference = 'Stop'
$configPath = Join-Path $TemplateRoot 'server.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw "server.json not found. Copy server.json.example and configure it first." }
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$pidFile = Join-Path $TemplateRoot 'run\server.pid'
New-Item -ItemType Directory -Force -Path (Join-Path $TemplateRoot 'run'), (Join-Path $TemplateRoot 'logs') | Out-Null

if (Test-Path -LiteralPath $pidFile) {
  $existingPid = [int](Get-Content -Raw -LiteralPath $pidFile)
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
    [pscustomobject]@{ state = 'Running'; pid = $existingPid; message = 'Already running' } | ConvertTo-Json -Compress
    exit 0
  }
  Remove-Item -LiteralPath $pidFile -Force
}

$runner = Join-Path $RuntimeRoot 'powershell\runner.ps1'
$commandLine = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -TemplateRoot `"$TemplateRoot`""
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
    throw "MCP process exited before opening port $($config.port). Check logs/server.err.log."
  }
}

throw "MCP startup timed out waiting for port $($config.port); the process was left running for inspection"
