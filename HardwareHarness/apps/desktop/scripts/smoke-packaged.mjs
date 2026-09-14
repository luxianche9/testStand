import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "@playwright/test";

const execFileAsync = promisify(execFile);
const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = resolve(desktopDir, "../..");
const executablePath = resolve(workspaceDir, "dist/win-unpacked/HardwareHarness.exe");
const bundledOpenCode = resolve(workspaceDir, "dist/win-unpacked/resources/opencode/opencode.exe");
const packagedResources = resolve(workspaceDir, "dist/win-unpacked/resources/third-party");

const userDataDir = await mkdtemp(join(tmpdir(), "hardwareharness-packaged-smoke-"));
const projectRoot = join(userDataDir, "packaged-smoke");
const gatewayPort = await availablePort();
const environment = {
  ...process.env,
  HARDWAREHARNESS_USER_DATA_DIR: userDataDir,
  HARDWAREHARNESS_GATEWAY_PORT: String(gatewayPort),
  HARDWAREHARNESS_AGENT_INTEGRATION_TEST_MODE: "1"
};
delete environment.ELECTRON_RUN_AS_NODE;

let application;
const launchedSidecarPids = new Set();
try {
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
  await page.evaluate((rootPath) => window.hardwareharness.projects.initializeFolder(rootPath), projectRoot);
  await page.evaluate(() => window.hardwareharness.settings.saveLlm({
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1",
    apiKey: "packaged-smoke-placeholder-key"
  }));
  await poll(async () => (await page.evaluate(() => window.hardwareharness.agents.openCodeStatus())).state === "running", 30_000);
  await page.evaluate(() => localStorage.setItem("hardwareharness.assistant-open", "true"));
  await page.reload();
  await page.getByText("packaged-smoke", { exact: true }).first().click();
  await verifyAgentUi(page);
  assert.deepEqual(rendererErrors, [], `Renderer errors during first launch:\n${rendererErrors.join("\n")}`);
  const firstSidecarPid = await waitForSidecar(baselinePids);
  launchedSidecarPids.add(firstSidecarPid);

  await application.close();
  application = undefined;
  await poll(async () => !(await openCodeProcesses()).some((item) => item.ProcessId === firstSidecarPid), 15_000);

  application = await launchPackaged();
  page = await application.firstWindow({ timeout: 90_000 });
  page.setDefaultTimeout(60_000);
  rendererErrors = collectRendererErrors(page);
  await page.getByRole("heading", { name: "最近项目" }).waitFor();
  await page.getByText("packaged-smoke", { exact: true }).first().click();
  await poll(async () => (await page.evaluate(() => window.hardwareharness.agents.openCodeStatus())).state === "running", 30_000);
  await verifyAgentUi(page);
  assert.deepEqual(rendererErrors, [], `Renderer errors during automatic restart launch:\n${rendererErrors.join("\n")}`);
  const secondSidecarPid = await waitForSidecar(new Set([...baselinePids, firstSidecarPid]));
  launchedSidecarPids.add(secondSidecarPid);
  assert.notEqual(secondSidecarPid, firstSidecarPid, "Second launch reused a stale sidecar process");

  await application.close();
  application = undefined;
  await poll(async () => !(await openCodeProcesses()).some((item) => item.ProcessId === secondSidecarPid), 15_000);
  console.log(`Packaged smoke passed (OpenCode PIDs ${firstSidecarPid} and ${secondSidecarPid} stopped with HardwareHarness).`);
} finally {
  await application?.close().catch(() => undefined);
  const remaining = await openCodeProcesses().catch(() => []);
  for (const sidecarPid of launchedSidecarPids) {
    if (remaining.some((item) => item.ProcessId === sidecarPid && samePath(item.ExecutablePath, bundledOpenCode))) {
      await execFileAsync("taskkill.exe", ["/PID", String(sidecarPid), "/T", "/F"], { windowsHide: true }).catch(() => undefined);
    }
  }
  await rm(userDataDir, { recursive: true, force: true });
}

async function launchPackaged() {
  return await electron.launch({ executablePath, env: environment, timeout: 90_000 });
}

function collectRendererErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  return errors;
}

async function verifyAgentUi(page) {
  const sidebar = page.locator(".tf-agent-sidebar");
  await sidebar.waitFor();
  await sidebar.locator(".tf-agent-thread").waitFor();
  await sidebar.getByRole("textbox", { name: "消息" }).waitFor();
  assert.equal(await page.locator(".opencode-host, .assistant-sidebar").count(), 0, "Legacy OpenCode DOM is still present");
  await sidebar.getByRole("button", { name: "打开会话抽屉" }).click();
  await page.getByRole("dialog", { name: "会话历史" }).waitFor();
  await page.keyboard.press("Escape");
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
    "Get-CimInstance Win32_Process -Filter \"Name = 'opencode.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"
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
