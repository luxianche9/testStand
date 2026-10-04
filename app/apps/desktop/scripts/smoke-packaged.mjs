import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "@playwright/test";
import { verifyAgentInterface } from "./agent-release-smoke.mjs";

const execFileAsync = promisify(execFile);
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = resolve(desktopDir, "../..");
const executablePath = resolve(process.env.TESTSTAND_SMOKE_EXECUTABLE ?? resolve(workspaceDir, "dist/win-unpacked/testStand.exe"));
const resourcesRoot = resolve(dirname(executablePath), "resources");
const bundledOpenCode = resolve(resourcesRoot, "opencode/opencode.exe");
const packagedResources = resolve(resourcesRoot, "third-party");
// The .tsdev device packages released with this build (devices/pack.py --all).
const devicePackagesDir = resolve(process.env.TESTSTAND_SMOKE_DEVICE_PACKAGES ?? resolve(workspaceDir, "../devices/dist"));

const userDataDir = await mkdtemp(join(tmpdir(), "teststand-packaged-smoke-"));
const projectName = "packaged-smoke 中文 项目";
const projectRoot = join(userDataDir, projectName);
const gatewayPort = await availablePort();
const gatewayTestToken = randomUUID();
const environment = {
  ...process.env,
  TESTSTAND_USER_DATA_DIR: userDataDir,
  TESTSTAND_GATEWAY_PORT: String(gatewayPort),
  TESTSTAND_AGENT_INTEGRATION_TEST_MODE: "1",
  TESTSTAND_GATEWAY_TEST_TOKEN: gatewayTestToken,
  UV_OFFLINE: "1",
  UV_CACHE_DIR: join(userDataDir, "empty-cache"),
  PATH: join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32")
};
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.TESTSTAND_BACKEND_EXECUTABLE;
delete environment.PYTHONPATH;

let application;
const launchedSidecarPids = new Set();
const processAudit = startProcessAudit();
try {
  await processAudit.ready;
  await verifyThirdPartyResources();
  const baselinePids = new Set(
    (await openCodeProcesses())
      .filter((item) => samePath(item.ExecutablePath, bundledOpenCode))
      .map((item) => item.ProcessId)
  );

  application = await launchPackaged();
  let page = await application.firstWindow({ timeout: 90_000 });
  page.setDefaultTimeout(60_000);
  let rendererErrors = collectRendererErrors(page);
  await page.getByRole("heading", { name: "最近项目" }).waitFor();
  await mkdir(projectRoot);
  await page.evaluate((rootPath) => window.teststand.projects.initializeFolder({ rootPath }), projectRoot);
  await page.evaluate(() => window.teststand.settings.saveLlm({
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1",
    apiKey: "packaged-smoke-placeholder-key"
  }));
  await poll(async () => (await page.evaluate(() => window.teststand.agents.openCodeStatus())).state === "running", 30_000);
  await page.evaluate(() => localStorage.setItem("teststand.assistant-open", "true"));
  await page.reload();
  await page.getByText(projectName, { exact: true }).first().click();
  const agentReport = await verifyAgentInterface(`http://127.0.0.1:${gatewayPort}/mcp`, gatewayTestToken);
  const agentReportPath = resolve(workspaceDir, "output/packaging/agent-interface.json");
  await mkdir(dirname(agentReportPath), { recursive: true });
  await writeFile(agentReportPath, JSON.stringify(agentReport, null, 2) + "\n");
  await verifyAgentUi(page);
  await verifyDevicePackages(application, page);
  assert.deepEqual(rendererErrors, [], `Renderer errors during first launch:\n${rendererErrors.join("\n")}`);
  const firstSidecarPid = await waitForSidecar(baselinePids);
  launchedSidecarPids.add(firstSidecarPid);

  await application.close();
  application = undefined;
  await processAudit.assertExited();
  await poll(async () => !(await openCodeProcesses()).some((item) => item.ProcessId === firstSidecarPid), 15_000);

  application = await launchPackaged();
  page = await application.firstWindow({ timeout: 90_000 });
  page.setDefaultTimeout(60_000);
  rendererErrors = collectRendererErrors(page);
  await page.getByRole("heading", { name: "最近项目" }).waitFor();
  await page.getByText(projectName, { exact: true }).first().click();
  await poll(async () => (await page.evaluate(() => window.teststand.agents.openCodeStatus())).state === "running", 30_000);
  await verifyAgentUi(page);
  await verifyPendingRemovalApplied(page);
  assert.deepEqual(rendererErrors, [], `Renderer errors during automatic restart launch:\n${rendererErrors.join("\n")}`);
  const secondSidecarPid = await waitForSidecar(new Set([...baselinePids, firstSidecarPid]));
  launchedSidecarPids.add(secondSidecarPid);
  assert.notEqual(secondSidecarPid, firstSidecarPid, "Second launch reused a stale sidecar process");

  await application.close();
  application = undefined;
  await processAudit.assertExited();
  await poll(async () => !(await openCodeProcesses()).some((item) => item.ProcessId === secondSidecarPid), 15_000);
  await processAudit.writeReport();
  console.log(`Packaged smoke passed (OpenCode PIDs ${firstSidecarPid} and ${secondSidecarPid} stopped with testStand).`);
} finally {
  await application?.close().catch(() => undefined);
  processAudit.stop();
  const remaining = await openCodeProcesses().catch(() => []);
  for (const sidecarPid of launchedSidecarPids) {
    if (remaining.some((item) => item.ProcessId === sidecarPid && samePath(item.ExecutablePath, bundledOpenCode))) {
      await execFileAsync("taskkill.exe", ["/PID", String(sidecarPid), "/T", "/F"], { windowsHide: true }).catch(() => undefined);
    }
  }
  await rm(userDataDir, { recursive: true, force: true });
}

async function launchPackaged() {
  const instance = await electron.launch({ executablePath, env: environment, timeout: 90_000,
    args: ["--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"] });
  processAudit.addRoot(instance.process().pid);
  await instance.evaluate(({ BrowserWindow, app }) => {
    const hide = (window) => { window.webContents.setBackgroundThrottling(false); window.hide(); window.on("show", () => window.hide()); };
    for (const window of BrowserWindow.getAllWindows()) hide(window);
    app.on("browser-window-created", (_event, window) => hide(window));
  });
  return instance;
}

function collectRendererErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  return errors;
}

async function verifyAgentUi(page) {
  // Opening a project restarts OpenCode in its folder; wait for the restarted server.
  await poll(async () => {
    const status = await page.evaluate(() => window.teststand.agents.openCodeStatus());
    return status.state === "running" && Boolean(status.apiUrl) && status.workspaceState === "ready";
  }, 60_000);
  const agentConfiguration = await page.evaluate(async () => {
    const status = await window.teststand.agents.openCodeStatus();
    const query = `?directory=${encodeURIComponent(status.workspace)}`;
    const read = async (path) => {
      try {
        return await fetch(`${status.apiUrl}${path}${query}`).then((response) => response.json());
      } catch (error) {
        throw new Error(`${status.apiUrl}${path}: ${error.message} (page origin ${location.origin})`);
      }
    };
    const [configuration, agents] = await Promise.all([read("/config"), read("/agent")]);
    return { configuration, agents };
  });
  assert.equal(agentConfiguration.configuration.default_agent, "build");
  for (const name of ["build", "plan"]) {
    const configured = agentConfiguration.configuration.agent[name].prompt;
    assert.ok(configured.includes("get_tool_contract"));
    assert.doesNotMatch(configured, /模拟|mock|simulate|simulation/i);
    assert.equal(agentConfiguration.agents.find((agent) => agent.name === name)?.prompt, configured);
  }
  const openSidebar = page.getByRole("button", { name: "打开 AI 侧栏", exact: true });
  if (await openSidebar.count()) await openSidebar.evaluate((button) => button.click());
  const sidebar = page.locator(".tf-agent-sidebar");
  await sidebar.waitFor();
  await sidebar.locator(".tf-agent-thread").waitFor();
  await sidebar.getByRole("textbox", { name: "消息" }).waitFor();
  assert.equal(await page.locator(".opencode-host, .assistant-sidebar").count(), 0, "Legacy OpenCode DOM is still present");
  await sidebar.getByRole("button", { name: "打开会话抽屉" }).evaluate((button) => button.click());
  await page.getByRole("dialog", { name: "会话历史" }).waitFor();
  await page.getByRole("button", { name: "关闭会话抽屉", exact: true }).evaluate((button) => button.click());
  await page.getByRole("dialog", { name: "会话历史" }).waitFor({ state: "hidden" });
}

/**
 * The release has no device types of its own: install pci1762 through the Devices page (the user's
 * path, with the native file dialog answered), the other packages through the API, then open sim
 * instances, including pci6208v, which runs in the frozen backend's isolated child process.
 */
async function verifyDevicePackages(application, page) {
  const files = (await readdir(devicePackagesDir)).filter((name) => name.endsWith(".tsdev")).sort();
  for (const type of ["pci1710l", "pci1762", "pci6208v", "cp118u_i"]) {
    assert.ok(files.some((name) => name.startsWith(`${type}-`)), `Missing device package for ${type} in ${devicePackagesDir}`);
  }
  assert.deepEqual(await page.evaluate(() => window.teststand.devices.listDeviceTypes()), [],
    "A release must not ship built-in device types");

  const relay = resolve(devicePackagesDir, files.find((name) => name.startsWith("pci1762-")));
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, relay);
  const click = (locator) => locator.evaluate((element) => element.click());
  await click(page.getByRole("tab", { name: "测试台架", exact: true }));
  await click(page.getByRole("button", { name: "设备类型" }));
  await click(page.getByRole("button", { name: /安装设备包/ }));
  const confirm = page.getByRole("dialog", { name: "安装设备包" });
  await confirm.getByText("Advantech PCI-1762", { exact: true }).waitFor();
  await confirm.getByText("Advantech DAQNavi", { exact: true }).waitFor();
  await click(confirm.getByRole("button", { name: "安装", exact: true }));
  await page.getByRole("status").filter({ hasText: "pci1762 0.2.0 已安装" }).waitFor();
  await click(page.getByRole("dialog", { name: "设备类型" }).getByText("关闭", { exact: true }));

  for (const name of files.filter((item) => !item.startsWith("pci1762-"))) {
    const bytes = [...await readFile(resolve(devicePackagesDir, name))];
    const result = await page.evaluate(async (data) => {
      const bytes = new Uint8Array(data);
      const report = await window.teststand.devices.inspectPackage({ data: bytes });
      if (report.problems.length) throw new Error(report.problems.join("; "));
      return window.teststand.devices.installPackage({ data: bytes });
    }, bytes);
    assert.equal(result.restartRequired, false, `${name} should be usable at once`);
  }
  const types = await page.evaluate(() => window.teststand.devices.listDeviceTypes());
  assert.deepEqual(types.map((item) => [item.type, item.source, item.error ?? null]).sort(), [
    ["cp118u_i", "package", null], ["pci1710l", "package", null], ["pci1762", "package", null], ["pci6208v", "package", null]
  ]);

  const calls = {
    pci1762: ["pci1762_set_relay", { channel: 0, closed: true }],
    pci6208v: ["pci6208v_set_voltage", { channel: 0, volts: 1.25 }]
  };
  for (const [type, [tool, args]] of Object.entries(calls)) {
    const result = await page.evaluate(async ({ type, tool, args }) => {
      const deviceId = `SMOKE_${type.toUpperCase()}`;
      const hardwareId = `${deviceId}_CARD`;
      await window.teststand.devices.saveDevice({ input: {
        deviceId, label: type, hardwareId, type, settings: {}, mode: "sim", enabled: true
      } });
      const status = await window.teststand.devices.refreshDevice({ deviceId });
      const call = await window.teststand.devices.callTool({ name: `${deviceId}__${tool}`, args: { hardwareId, ...args } });
      return { status, call };
    }, { type, tool, args });
    assert.equal(result.status.transport.state, "online", `${type}: ${JSON.stringify(result.status.transport)}`);
    assert.ok(JSON.stringify(result.call).includes(String(Object.values(args).at(-1))), `${type}: ${JSON.stringify(result.call)}`);
  }
  const removal = await page.evaluate(() => window.teststand.devices.uninstallPackage({ deviceType: "pci1762" }));
  assert.equal(removal.restartRequired, true);
}

async function verifyPendingRemovalApplied(page) {
  const packages = await page.evaluate(() => window.teststand.devices.listPackages());
  assert.deepEqual(packages.map((item) => item.type).sort(), ["cp118u_i", "pci1710l", "pci6208v"]);
  const status = await page.evaluate(() => window.teststand.devices.refreshDevice({ deviceId: "SMOKE_PCI1762" }));
  assert.match(JSON.stringify(status), /pci1762 is not installed/);
}

function startProcessAudit() {
  const roots = new Set();
  const tracked = new Map();
  let latest = [];
  let sampleCount = 0;
  let pending = "";
  let stderr = "";
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
while ($true) {
  $items = @(Get-CimInstance Win32_Process | ForEach-Object {
    $role = 'other'
    if ($_.Name -eq 'testStand.exe') { $role = 'electron' }
    elseif ($_.Name -eq 'teststand-backend.exe') { $role = 'backend' }
    elseif ($_.Name -eq 'opencode.exe') { $role = 'opencode' }
    elseif ($_.Name -eq 'python.exe') { $role = 'python' }
    [pscustomobject]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name;
      executable = $_.ExecutablePath; started = $_.CreationDate.ToUniversalTime().ToString('o'); role = $role }
  })
  ConvertTo-Json -InputObject $items -Compress
  Start-Sleep -Milliseconds 100
}`;
  const monitor = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  function capture() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of latest) {
        const key = `${item.pid}:${item.started}`;
        if (tracked.has(key)) continue;
        if (roots.has(item.pid) || [...tracked.values()].some((parent) =>
          parent.pid === item.parent && parent.started <= item.started)) {
          tracked.set(key, item);
          changed = true;
        }
      }
    }
  }
  monitor.stdout.setEncoding("utf8");
  monitor.stdout.on("data", (data) => {
    pending += data;
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      if (!line) continue;
      try { latest = JSON.parse(line); sampleCount += 1; capture(); resolveReady(); }
      catch (error) { rejectReady(error); }
    }
  });
  monitor.stderr.on("data", (data) => { stderr += data; });
  monitor.on("error", rejectReady);
  monitor.on("exit", (code) => { if (sampleCount === 0) rejectReady(new Error(`Process monitor exited ${code}: ${stderr}`)); });
  return {
    ready,
    addRoot(pid) { assert.ok(pid); roots.add(pid); capture(); },
    async assertExited() {
      await poll(async () => [...tracked.values()].every((item) => !latest.some((live) =>
        live.pid === item.pid && live.started === item.started)), 20_000);
    },
    async writeReport() {
      for (const role of ["electron", "backend", "opencode"]) {
        assert.ok([...tracked.values()].some((item) => item.role === role), `Missing process audit role: ${role}`);
      }
      const report = resolve(workspaceDir, "output/packaging/process-cleanup.json");
      await mkdir(dirname(report), { recursive: true });
      await writeFile(report, JSON.stringify({ executablePath, roots: [...roots], sampleCount,
        tracked: [...tracked.values()], remaining: [], allObservedDescendantsExited: true }, null, 2) + "\n");
    },
    stop() { monitor.kill(); }
  };
}

async function verifyThirdPartyResources() {
  const paths = [
    resolve(packagedResources, "assistant-ui/LICENSE"),
    resolve(packagedResources, "assistant-ui/SOURCE.txt"),
    resolve(packagedResources, "fonts/OFL-1.1.txt"),
    resolve(packagedResources, "fonts/THIRD_PARTY_NOTICES.txt")
  ];
  await Promise.all(paths.map((path) => access(path)));
  const source = await readFile(paths[1], "utf8");
  assert.match(source, /8bba3aaadcae042b4750436e6aa62bbba4815dde/);
}

async function waitForSidecar(excludedPids) {
  let pid;
  await poll(async () => {
    const process = (await openCodeProcesses()).find((item) =>
      samePath(item.ExecutablePath, bundledOpenCode) && !excludedPids.has(item.ProcessId)
    );
    pid = process?.ProcessId;
    return pid !== undefined;
  }, 10_000);
  return pid;
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
  if (!port) throw new Error("Could not allocate a smoke-test gateway port");
  return port;
}

async function openCodeProcesses() {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter \"Name = 'opencode.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"
  ], { windowsHide: true });
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function samePath(left, right) {
  return typeof left === "string" && left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

async function poll(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Smoke check timed out after ${timeoutMs} ms`);
}
