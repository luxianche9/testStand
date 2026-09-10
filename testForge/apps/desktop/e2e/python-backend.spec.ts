import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const desktopDir = resolve(import.meta.dirname, "..");
const execute = promisify(execFile);

async function backendPid(application: ElectronApplication): Promise<number> {
  const parent = await application.evaluate(() => process.pid);
  if (!parent) throw new Error("Electron PID is unavailable");
  const result = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parent}' | Where-Object { $_.Name -eq 'python.exe' -or $_.Name -eq 'testforge-backend.exe' } | Select-Object -ExpandProperty ProcessId`
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

test("Python reads existing safeStorage ciphertext and exits without an orphan", async () => {
  const userData = await mkdtemp(join(tmpdir(), "testforge 中文 profile "));
  const env = { ...process.env, TESTFORGE_USER_DATA_DIR: userData,
    TESTFORGE_GATEWAY_PORT: "0", TESTFORGE_AGENT_INTEGRATION_TEST_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.TESTFORGE_DESKTOP_EXECUTABLE;
  if (executablePath) {
    env.PATH = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    delete env.PYTHONPATH;
    delete env.PYTHONHOME;
    delete env.VIRTUAL_ENV;
    delete env.TESTFORGE_BACKEND_EXECUTABLE;
  }
  const launch = () => electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : [desktopDir],
    cwd: executablePath ? dirname(executablePath) : desktopDir, env
  });
  let application: ElectronApplication | undefined;
  try {
    application = await launch();
    const first = await application.firstWindow();
    await expect(first.getByRole("heading", { name: "最近项目" })).toBeVisible();
    const ciphertext = await application.evaluate(({ safeStorage }) =>
      safeStorage.encryptString(JSON.stringify({ apiKey: "legacy-test-key" })).toString("base64")
    );
    const firstPid = await backendPid(application);
    await application.close();
    application = undefined;
    await expectExited(firstPid);
    const path = join(userData, "secrets.json");
    const secrets = JSON.parse(await readFile(path, "utf8"));
    secrets.entries["opencode.llm.api-key"] = ciphertext;
    await writeFile(path, `${JSON.stringify(secrets, null, 2)}\n`, "utf8");

    application = await launch();
    const second = await application.firstWindow();
    const llm = await second.evaluate(() => window.testforge.settings.getLlm());
    expect(llm.apiKeyConfigured).toBe(true);
    expect(await second.evaluate((value) => window.testforge.settings.saveLlm(value), {
      baseUrl: llm.baseUrl, model: llm.model
    })).toEqual(llm);
    expect(JSON.parse(await readFile(path, "utf8")).entries["opencode.llm.api-key"]).toBe(ciphertext);
    const secondPid = await backendPid(application);
    await application.close();
    application = undefined;
    await expectExited(secondPid);
  } finally {
    await application?.close();
    await rm(userData, { recursive: true, force: true });
  }
});
