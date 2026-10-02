import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { app } from "electron";
import { BackendClient, type BackendHandshake } from "./python-bridge.js";
import { logger } from "./logger.js";

const HANDSHAKE_TIMEOUT_MS = 60_000;

/** Start the Python service (design doc §9.4) and connect main to it. The renderer talks to
 * `client.api` directly; main keeps the child's stdin, whose end is the shutdown signal. */
export async function startPythonBackend(event: (event: string, payload: unknown) => void): Promise<BackendClient> {
  const developmentRoot = resolve(app.getAppPath(), "../../python");
  const frozen = app.isPackaged || Boolean(process.env.HARDWAREHARNESS_BACKEND_EXECUTABLE);
  const executable = process.env.HARDWAREHARNESS_BACKEND_EXECUTABLE ?? (app.isPackaged
    ? join(process.resourcesPath, "backend", "hardwareharness-backend.exe")
    : join(developmentRoot, ".venv", "Scripts", "python.exe"));
  const args = [
    ...(frozen ? [] : ["-u", "-m", "hardwareharness_backend.host"]),
    "--user-data", app.getPath("userData"),
    "--gateway-port", String(Number(process.env.HARDWAREHARNESS_GATEWAY_PORT ?? 8000)),
    ...(process.env.HARDWAREHARNESS_AGENT_INTEGRATION_TEST_MODE === "1" ? ["--integration-test-mode"] : [])
  ];
  // HARDWAREHARNESS_GATEWAY_TEST_TOKEN reaches the service through the inherited environment only.
  const child = spawn(executable, args, {
    cwd: app.isPackaged ? process.resourcesPath : developmentRoot,
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" }
  });
  const exited = new Promise<void>((done) => child.once("close", () => done()));
  child.stdin.on("error", (error) => logger.warn("Python backend stdin", error));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => logger.warn("Python backend", chunk.trimEnd()));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    const handshake = await new Promise<BackendHandshake>((resolveHandshake, reject) => {
      const timer = setTimeout(() => reject(new Error("Python backend did not start in time")), HANDSHAKE_TIMEOUT_MS);
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(`Python backend exited during startup (${String(code ?? signal)})`)));
      lines.once("line", (line) => {
        clearTimeout(timer);
        try { resolveHandshake(parseHandshake(line)); }
        catch (error) { reject(error); }
      });
    });
    // Everything after the handshake is diagnostics.
    lines.on("line", (line) => logger.info("Python backend", line));
    child.on("exit", (code, signal) => logger.warn("Python backend exited", String(code ?? signal)));
    const client = new BackendClient({
      handshake,
      process: { stdin: child.stdin, kill: () => child.kill(), exited },
      event,
      log: (message, error) => logger.warn(message, error)
    });
    await client.start();
    return client;
  } catch (error) {
    child.stdin.end();
    child.kill();
    throw error;
  }
}

function parseHandshake(line: string): BackendHandshake {
  const value = JSON.parse(line) as Partial<BackendHandshake>;
  if (typeof value.port !== "number" || typeof value.token !== "string" || typeof value.hostToken !== "string") {
    throw new Error("Invalid Python backend handshake");
  }
  return value as BackendHandshake;
}
