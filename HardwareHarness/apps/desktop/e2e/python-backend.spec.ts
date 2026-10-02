import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { rendererReady } from "./renderer.js";

const desktopDir = resolve(import.meta.dirname, "..");
const execute = promisify(execFile);

async function backendPid(application: ElectronApplication): Promise<number> {
  const parent = await application.evaluate(() => process.pid);
  if (!parent) throw new Error("Electron PID is unavailable");
  const result = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parent}' | Where-Object { $_.Name -eq 'python.exe' -or $_.Name -eq 'hardwareharness-backend.exe' } | Select-Object -ExpandProperty ProcessId`
  ], { windowsHide: true });
  const ids = result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  expect(ids).toHaveLength(1);
  expect(ids[0]).toBeGreaterThan(0);
  return ids[0]!;
}

async function expectExited(pid: number): Promise<void> {
  await expect.poll(async () => {
    try { process.kill(pid, 0); return false; }
    catch { return true; }
  }).toBe(true);
}

test("Python backend exits with the window and leaves no orphan", async () => {
  const userData = await mkdtemp(join(tmpdir(), "hardwareharness 中文 profile "));
  const env = { ...process.env, HARDWAREHARNESS_USER_DATA_DIR: userData,
    HARDWAREHARNESS_GATEWAY_PORT: "0", HARDWAREHARNESS_AGENT_INTEGRATION_TEST_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.HARDWAREHARNESS_DESKTOP_EXECUTABLE;
  if (executablePath) {
    env.PATH = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    delete env.PYTHONPATH;
    delete env.PYTHONHOME;
    delete env.VIRTUAL_ENV;
    delete env.HARDWAREHARNESS_BACKEND_EXECUTABLE;
  }
  const launch = () => electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : [desktopDir],
    cwd: executablePath ? dirname(executablePath) : desktopDir, env
  });
  let application: ElectronApplication | undefined;
  try {
    application = await launch();
    const first = await rendererReady(await application.firstWindow());
    await expect(first.getByRole("heading", { name: "最近项目" })).toBeVisible();
    const pid = await backendPid(application);
    await application.close();
    application = undefined;
    await expectExited(pid);
  } finally {
    await application?.close();
    await rm(userData, { recursive: true, force: true });
  }
});
