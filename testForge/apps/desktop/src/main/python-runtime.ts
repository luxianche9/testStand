import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { app, safeStorage } from "electron";
import type { TestForgeEventName } from "@testforge/contracts/desktop";
import { PythonBridge } from "./python-bridge.js";
import { logger } from "./logger.js";
import { orchestrationSafetyFromEnv } from "./orchestration-safety.js";

export async function startPythonBackend(event: (name: TestForgeEventName, payload: unknown, workspaceChanged?: boolean) => void): Promise<PythonBridge> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows credential encryption is not available");
  const developmentRoot = resolve(app.getAppPath(), "../../python");
  const frozen = app.isPackaged || Boolean(process.env.TESTFORGE_BACKEND_EXECUTABLE);
  const executable = process.env.TESTFORGE_BACKEND_EXECUTABLE ?? (app.isPackaged
    ? join(process.resourcesPath, "backend", "testforge-backend.exe")
    : join(developmentRoot, ".venv", "Scripts", "python.exe"));
  const child = spawn(executable, frozen ? [] : ["-u", "-m", "testforge_backend.host"], {
    cwd: app.isPackaged ? process.resourcesPath : developmentRoot,
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" }
  });
  const bridge = new PythonBridge(child, {
    event,
    log: (message) => logger.warn("Python backend", message.trimEnd()),
    hostCall: async (method, params) => {
      const value = (params as { value?: unknown })?.value;
      if (method === "host.safeStorage.encrypt" && typeof value === "string") return new Uint8Array(safeStorage.encryptString(value));
      if (method === "host.safeStorage.decrypt" && value instanceof Uint8Array) return safeStorage.decryptString(Buffer.from(value));
      throw new Error(`Unknown host callback: ${method}`);
    }
  });
  try {
    const ready = await bridge.call<{ protocolVersion: number }>("backend.initialize", {
      userData: app.getPath("userData"),
      gatewayPort: Number(process.env.TESTFORGE_GATEWAY_PORT ?? 8000),
      integrationTestMode: process.env.TESTFORGE_AGENT_INTEGRATION_TEST_MODE === "1",
      gatewayTestToken: process.env.TESTFORGE_GATEWAY_TEST_TOKEN,
      safety: orchestrationSafetyFromEnv(process.env),
      locale: new Intl.Collator().resolvedOptions().locale
    });
    if (ready.protocolVersion !== 1) throw new Error("Unsupported Python backend protocol version");
    return bridge;
  } catch (error) {
    child.stdin.end();
    child.kill();
    throw error;
  }
}
