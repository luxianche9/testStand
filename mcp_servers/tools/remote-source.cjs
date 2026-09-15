const { app, safeStorage } = require("electron");
const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, existsSync } = require("node:fs");
const { join, dirname, relative, resolve, sep } = require("node:path");

const realHardwareRoot = resolve(__dirname, "..");
const workspaceRoot = resolve(realHardwareRoot, "..");
const hardwareHarnessUserData = process.env.HARDWAREHARNESS_USER_DATA_DIR
  || process.env.HARDWAREHARNESS_USER_DATA
  || join(process.env.APPDATA, "HardwareHarness");
app.setPath("userData", hardwareHarnessUserData);
const { Client } = require("ssh2");
const config = JSON.parse(readFileSync(join(realHardwareRoot, "servers.json"), "utf8"));

const sourceExtensions = new Set([
  ".py", ".pyi", ".ps1", ".psm1", ".psd1", ".json", ".toml", ".ini",
  ".cfg", ".conf", ".yaml", ".yml", ".md", ".txt", ".lock", ".xml",
  ".bat", ".cmd"
]);
const excludedDirectoryPatterns = [
  /^(?:\.venv|venv|logs|run|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)$/i,
  /\.egg-info$/i,
  /^(?:backup|deploy-staging|source-backup)-/i
];
const excludedFilePatterns = [
  /^server\.json$/i,
  /^(?:\.env|secrets?(?:\..*)?|credentials?(?:\..*)?)$/i,
  /\.(?:log|pyc|pyo|pem|key|pfx|p12|crt|cer)$/i
];
const localOnlyPreservedFiles = new Set(["server.example.json"]);

function parseArguments(argv) {
  const [action, ...rest] = argv;
  if (!["inventory", "pull", "deploy", "verify"].includes(action)) {
    throw new Error("Usage: pull|deploy|verify|inventory [--server all|pci1710l|pci1762|pci6208v|cp118u_i] [--skip-tests]");
  }
  let server = "all";
  let skipTests = false;
  let force = false;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--server") server = rest[++index];
    else if (rest[index] === "--skip-tests") skipTests = true;
    else if (rest[index] === "--force") force = true;
    else throw new Error(`Unknown argument: ${rest[index]}`);
  }
  const selected = server === "all" ? config.servers : config.servers.filter((item) => item.id === server);
  if (selected.length === 0) throw new Error(`Unknown server: ${server}`);
  return { action, selected, skipTests, force };
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function remoteSftpPath(value) {
  return `/${value.replaceAll("\\", "/")}`;
}

function normalizeRelative(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error(`Unsafe relative path: ${value}`);
  }
  return normalized;
}

function isSourcePath(relativePath) {
  const normalized = normalizeRelative(relativePath);
  const parts = normalized.split("/");
  if (parts.some((part) => excludedDirectoryPatterns.some((pattern) => pattern.test(part)))) return false;
  const name = parts.at(-1);
  if (excludedFilePatterns.some((pattern) => pattern.test(name))) return false;
  const dot = name.lastIndexOf(".");
  return dot < 0 || sourceExtensions.has(name.slice(dot).toLowerCase());
}

function localSourceFiles(root) {
  if (!existsSync(root)) return [];
  const result = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        if (isSourcePath(`${rel}/placeholder.py`)) visit(absolute);
      } else if (entry.isFile() && isSourcePath(rel)) {
        const content = readFileSync(absolute);
        result.push({ path: rel, absolute, length: content.length, sha256: sha256(content) });
      }
    }
  };
  visit(root);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function secretFromSafeStorage(key) {
  const secretsPath = process.env.HARDWAREHARNESS_SECRETS_PATH || join(hardwareHarnessUserData, "secrets.json");
  const document = JSON.parse(readFileSync(secretsPath, "utf8"));
  const encrypted = document.entries?.[key];
  if (!encrypted) throw new Error(`Credential ${key} was not found in ${secretsPath}`);
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Electron safeStorage is unavailable");
  return JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, "base64")));
}

function credentialFromSafeStorage() {
  const password = process.env.HARDWAREHARNESS_REMOTE_PASSWORD;
  if (password) return { kind: "password", password };
  return secretFromSafeStorage(config.computer.credentialKey);
}

function connect(credential) {
  return new Promise((resolvePromise, reject) => {
    const client = new Client();
    client.once("ready", () => resolvePromise(client));
    client.once("error", reject);
    const options = {
      host: config.computer.host,
      port: config.computer.port,
      username: config.computer.username,
      readyTimeout: 15_000,
      keepaliveInterval: 5_000
    };
    if (credential.kind === "password") options.password = credential.password;
    else if (credential.kind === "privateKey") {
      options.privateKey = credential.privateKey;
      if (credential.passphrase) options.passphrase = credential.passphrase;
    } else throw new Error(`Unsupported SSH credential kind: ${credential.kind}`);
    client.connect(options);
  });
}

function execPowerShell(client, script, timeoutMs = 120_000) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolvePromise, reject) => {
    client.exec(`powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, (error, stream) => {
      if (error) return reject(error);
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        stream.close();
        reject(new Error(`Remote command timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      stream.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      stream.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      stream.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise({ stdout, stderr });
        else reject(new Error(`Remote command failed (${code}): ${stderr.trim() || stdout.trim()}`));
      });
    });
  });
}

function openSftp(client) {
  return new Promise((resolvePromise, reject) => client.sftp((error, sftp) => error ? reject(error) : resolvePromise(sftp)));
}

function fastGet(sftp, remotePath, localPath) {
  return new Promise((resolvePromise, reject) => sftp.fastGet(remotePath, localPath, {}, (error) => error ? reject(error) : resolvePromise()));
}

function fastPut(sftp, localPath, remotePath) {
  return new Promise((resolvePromise, reject) => sftp.fastPut(localPath, remotePath, {}, (error) => error ? reject(error) : resolvePromise()));
}

function remoteFilterScript(rootVariable = "$root") {
  const extensions = [...sourceExtensions].map(psQuote).join(",");
  return `
$sourceExtensions = @(${extensions})
function Test-SourceFile([System.IO.FileInfo]$file, [string]$relativePath) {
  $parts = $relativePath -split '[\\/]'
  foreach ($part in $parts) {
    if ($part -match '^(\\.venv|venv|logs|run|__pycache__|\\.pytest_cache|\\.mypy_cache|\\.ruff_cache)$') { return $false }
    if ($part -match '\\.egg-info$') { return $false }
    if ($part -match '^(backup|deploy-staging|source-backup)-') { return $false }
  }
  if ($file.Name -ieq 'server.json') { return $false }
  if ($file.Name -match '^(\\.env|secrets?(\\..*)?|credentials?(\\..*)?)$') { return $false }
  if ($file.Name -match '\\.(log|pyc|pyo|pem|key|pfx|p12|crt|cer)$') { return $false }
  return [string]::IsNullOrEmpty($file.Extension) -or $sourceExtensions -contains $file.Extension.ToLowerInvariant()
}
`;
}

async function remoteManifest(client, server, rootOverride) {
  const root = rootOverride || server.remoteRoot;
  const result = await execPowerShell(client, `
$ErrorActionPreference = 'Stop'
$root = ${psQuote(root)}
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "Remote root not found: $root" }
${remoteFilterScript()}
Get-ChildItem -LiteralPath $root -File -Recurse | ForEach-Object {
  $relativePath = $_.FullName.Substring($root.Length).TrimStart('\\').Replace('\\', '/')
  if (Test-SourceFile $_ $relativePath) {
    [pscustomobject]@{
      path = $relativePath
      length = $_.Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
    } | ConvertTo-Json -Compress
  }
}`);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

async function pullServer(client, sftp, server, force) {
  const target = resolve(realHardwareRoot, "servers", server.id);
  const serversRoot = resolve(realHardwareRoot, "servers") + sep;
  if (!target.startsWith(serversRoot)) throw new Error(`Unsafe local target: ${target}`);
  mkdirSync(target, { recursive: true });
  const manifest = await remoteManifest(client, server);
  const remotePaths = new Set(manifest.map((file) => file.path));
  const localFiles = localSourceFiles(target);
  const remoteHashes = new Map(manifest.map((file) => [file.path, file.sha256]));
  const changed = localFiles.filter((file) =>
    !localOnlyPreservedFiles.has(file.path) && remoteHashes.get(file.path) !== file.sha256
  );
  if (changed.length && !force) {
    throw new Error(`Local changes would be overwritten: ${changed.map((file) => file.path).join(", ")}. Re-run pull.ps1 with -Force to replace them.`);
  }
  for (const file of localFiles) {
    if (!remotePaths.has(file.path) && !localOnlyPreservedFiles.has(file.path)) rmSync(file.absolute);
  }
  for (const file of manifest) {
    const rel = normalizeRelative(file.path);
    const destination = resolve(target, ...rel.split("/"));
    if (!destination.startsWith(target + sep)) throw new Error(`Unsafe local destination: ${destination}`);
    mkdirSync(dirname(destination), { recursive: true });
    await fastGet(sftp, remoteSftpPath(`${server.remoteRoot}\\${rel.replaceAll("/", "\\")}`), destination);
    const actual = sha256(readFileSync(destination));
    if (actual !== file.sha256) throw new Error(`Hash mismatch after pull: ${server.id}/${rel}`);
  }
  console.log(`[pull] ${server.label}: ${manifest.length} files`);
}

async function verifyServer(client, server) {
  const localRoot = resolve(realHardwareRoot, "servers", server.id);
  const local = localSourceFiles(localRoot);
  const remote = await remoteManifest(client, server);
  const remoteMap = new Map(remote.map((file) => [file.path, file.sha256]));
  const localMap = new Map(local
    .filter((file) => !localOnlyPreservedFiles.has(file.path) || remoteMap.has(file.path))
    .map((file) => [file.path, file.sha256]));
  const differences = [...new Set([...localMap.keys(), ...remoteMap.keys()])]
    .filter((path) => localMap.get(path) !== remoteMap.get(path));
  if (differences.length) throw new Error(`${server.label} differs in ${differences.length} file(s): ${differences.join(", ")}`);
  console.log(`[verify] ${server.label}: ${local.length} files match`);
}

async function deployServer(client, sftp, server, skipTests) {
  const localRoot = resolve(realHardwareRoot, "servers", server.id);
  const files = localSourceFiles(localRoot);
  if (files.length === 0) throw new Error(`No source files found for ${server.label}. Run pull.ps1 first.`);
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const staging = `${server.remoteRoot}\\deploy-staging-${timestamp}`;
  const backup = `${server.remoteRoot}\\source-backup-${timestamp}`;
  const directories = [...new Set(files.map((file) => file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""))];
  await execPowerShell(client, `
$ErrorActionPreference = 'Stop'
$staging = ${psQuote(staging)}
New-Item -ItemType Directory -Force -Path $staging | Out-Null
${directories.map((directory) => `New-Item -ItemType Directory -Force -Path (Join-Path $staging ${psQuote(directory.replaceAll("/", "\\"))}) | Out-Null`).join("\n")}`);
  try {
    for (const file of files) {
      const destination = `${staging}\\${file.path.replaceAll("/", "\\")}`;
      await fastPut(sftp, file.absolute, remoteSftpPath(destination));
    }
    const staged = await remoteManifest(client, server, staging);
    const stagedMap = new Map(staged.map((file) => [file.path, file.sha256]));
    const mismatch = files.find((file) => stagedMap.get(file.path) !== file.sha256);
    if (mismatch || staged.length !== files.length) throw new Error(`Staging verification failed for ${server.label}${mismatch ? `: ${mismatch.path}` : ""}`);

    const deployResult = await execPowerShell(client, `
$ErrorActionPreference = 'Stop'
$root = ${psQuote(server.remoteRoot)}
$staging = ${psQuote(staging)}
$backup = ${psQuote(backup)}
${remoteFilterScript()}
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$oldFiles = @(Get-ChildItem -LiteralPath $root -File -Recurse | Where-Object {
  $relativePath = $_.FullName.Substring($root.Length).TrimStart('\\').Replace('\\', '/')
  Test-SourceFile $_ $relativePath
})
foreach ($file in $oldFiles) {
  $relativePath = $file.FullName.Substring($root.Length).TrimStart('\\')
  $destination = Join-Path $backup $relativePath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
}
& (Join-Path $root 'stop.ps1') | Out-Null
foreach ($file in $oldFiles) { Remove-Item -LiteralPath $file.FullName -Force }
Get-ChildItem -LiteralPath $staging -File -Recurse | ForEach-Object {
  $relativePath = $_.FullName.Substring($staging.Length).TrimStart('\\')
  $destination = Join-Path $root $relativePath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}
Remove-Item -LiteralPath $staging -Recurse -Force
Write-Output $backup`, 180_000);
    const backupPath = deployResult.stdout.trim().split(/\r?\n/).at(-1);
    try {
      if (!skipTests) {
        await execPowerShell(client, `
$ErrorActionPreference = 'Stop'
$root = ${psQuote(server.remoteRoot)}
$python = @(
  (Join-Path $root 'venv\\Scripts\\python.exe'),
  (Join-Path $root '.venv\\Scripts\\python.exe')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $python) { throw "Python virtual environment not found under $root" }
$env:PYTHONPATH = Join-Path $root 'app\\src'
$env:HARDWAREHARNESS_SERVER_CONFIG = Join-Path $root 'server.json'
& $python -m unittest discover -s (Join-Path $root 'app\\tests') -p 'test_*.py'
if ($LASTEXITCODE -ne 0) { throw "Unit tests failed with exit code $LASTEXITCODE" }`, 300_000);
      }
      await execPowerShell(client, `
$ErrorActionPreference = 'Stop'
$root = ${psQuote(server.remoteRoot)}
& (Join-Path $root 'start.ps1') | Out-Null
$healthUrl = ${psQuote(server.healthUrl)}
for ($attempt = 1; $attempt -le 15; $attempt++) {
  try {
    $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
    if ($response.healthy -eq $true) { $response | ConvertTo-Json -Compress; exit 0 }
  } catch {}
  Start-Sleep -Seconds 1
}
throw "Health check failed: $healthUrl"`, 180_000);
      console.log(`[deploy] ${server.label}: ${files.length} files, backup ${backupPath}`);
    } catch (error) {
      await execPowerShell(client, `
$ErrorActionPreference = 'Continue'
$root = ${psQuote(server.remoteRoot)}
$backup = ${psQuote(backupPath)}
& (Join-Path $root 'stop.ps1') | Out-Null
${remoteFilterScript()}
Get-ChildItem -LiteralPath $root -File -Recurse | ForEach-Object {
  $relativePath = $_.FullName.Substring($root.Length).TrimStart('\\').Replace('\\', '/')
  if (Test-SourceFile $_ $relativePath) { Remove-Item -LiteralPath $_.FullName -Force }
}
Get-ChildItem -LiteralPath $backup -File -Recurse | ForEach-Object {
  $relativePath = $_.FullName.Substring($backup.Length).TrimStart('\\')
  $destination = Join-Path $root $relativePath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}
& (Join-Path $root 'start.ps1') | Out-Null`, 180_000);
      throw new Error(`${server.label} deployment failed and was rolled back: ${error.message}`);
    }
  } catch (error) {
    await execPowerShell(client, `if (Test-Path -LiteralPath ${psQuote(staging)}) { Remove-Item -LiteralPath ${psQuote(staging)} -Recurse -Force }`).catch(() => {});
    throw error;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const credential = credentialFromSafeStorage();
  const client = await connect(credential);
  try {
    const sftp = options.action === "pull" || options.action === "deploy" ? await openSftp(client) : null;
    if (options.action === "inventory") {
      for (const server of options.selected) {
        const manifest = await remoteManifest(client, server);
        console.log(JSON.stringify({ server: server.id, files: manifest }, null, 2));
      }
      return;
    }
    const failures = [];
    for (const server of options.selected) {
      try {
        if (options.action === "pull") await pullServer(client, sftp, server, options.force);
        else if (options.action === "deploy") await deployServer(client, sftp, server, options.skipTests);
        else await verifyServer(client, server);
      } catch (error) {
        failures.push(`${server.label}: ${error.message}`);
        console.error(`[error] ${server.label}: ${error.message}`);
      }
    }
    if (failures.length) throw new Error(failures.join("\n"));
  } finally {
    client.end();
  }
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error?.stack || String(error));
    app.exit(1);
  });
