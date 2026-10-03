import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { app } from "electron";
import type { LocalApiEndpoint } from "../shared/desktop-ipc.js";
import { logger } from "./logger.js";

const require = createRequire(import.meta.url);
const HANDSHAKE_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;

/** The one stdout line the service prints once it listens (design doc §9.4). */
interface BackendHandshake {
  port: number;
  token: string;
  version: string;
}

export interface PythonBackend {
  /** The local HTTP API; the renderer gets it on `desktop.endpoint`. */
  endpoint: LocalApiEndpoint;
  /** Closing stdin is the shutdown signal: the service releases devices and OpenCode, then exits. */
  shutdown(): Promise<void>;
}

/** Start the Python service, which owns everything but windows and dialogs. Main keeps the child's
 * stdin, whose end is the shutdown signal. */
export async function startPythonBackend(): Promise<PythonBackend> {
  const developmentRoot = resolve(app.getAppPath(), "../../python");
  const frozen = app.isPackaged || Boolean(process.env.HARDWAREHARNESS_BACKEND_EXECUTABLE);
  const executable = process.env.HARDWAREHARNESS_BACKEND_EXECUTABLE ?? (app.isPackaged
    ? join(process.resourcesPath, "backend", "hardwareharness-backend.exe")
    : join(developmentRoot, ".venv", "Scripts", "python.exe"));
  const args = [
    ...(frozen ? [] : ["-u", "-m", "hardwareharness_backend.host"]),
    "--user-data", app.getPath("userData"),
    "--gateway-port", String(Number(process.env.HARDWAREHARNESS_GATEWAY_PORT ?? 8000)),
    "--opencode", openCodeBinary(),
    ...rendererOrigins().flatMap((origin) => ["--renderer-origin", origin]),
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
  let handshake: BackendHandshake;
  try {
    handshake = await new Promise<BackendHandshake>((resolveHandshake, reject) => {
      const timer = setTimeout(() => reject(new Error("Python backend did not start in time")), HANDSHAKE_TIMEOUT_MS);
      child.once("error", reject);
      child.once("exit", (code, signal) => reject(new Error(`Python backend exited during startup (${String(code ?? signal)})`)));
      lines.once("line", (line) => {
        clearTimeout(timer);
        try { resolveHandshake(parseHandshake(line)); }
        catch (error) { reject(error); }
      });
    });
  } catch (error) {
    child.stdin.end();
    child.kill();
    throw error;
  }
  // Everything after the handshake is diagnostics.
  lines.on("line", (line) => logger.info("Python backend", line));
  child.on("exit", (code, signal) => logger.warn("Python backend exited", String(code ?? signal)));
  let stopping: Promise<void> | undefined;
  return {
    endpoint: { url: `http://127.0.0.1:${handshake.port}`, token: handshake.token },
    shutdown: () => stopping ??= (async () => {
      child.stdin.end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((done) => { timer = setTimeout(() => done("timeout"), SHUTDOWN_TIMEOUT_MS); });
      try {
        if (await Promise.race([exited, timeout]) === "timeout") {
          logger.warn("Python backend did not exit; killing it");
          child.kill();
          await exited;
        }
      } finally {
        clearTimeout(timer);
      }
    })()
  };
}

function parseHandshake(line: string): BackendHandshake {
  const value = JSON.parse(line) as Partial<BackendHandshake>;
  if (typeof value.port !== "number" || typeof value.token !== "string") throw new Error("Invalid Python backend handshake");
  return value as BackendHandshake;
}

/** The bundled OpenCode executable, which the service starts. */
function openCodeBinary(): string {
  if (app.isPackaged) return join(process.resourcesPath, "opencode", "opencode.exe");
  try { return require.resolve("opencode-windows-x64-baseline/bin/opencode.exe"); }
  catch { return join(dirname(app.getAppPath()), "resources", "opencode", "opencode.exe"); }
}

/** Where the renderer's requests come from: `null` for the built `file://` page, plus the dev server. */
function rendererOrigins(): string[] {
  const origins = ["null"];
  if (process.env.ELECTRON_RENDERER_URL) {
    try { origins.push(new URL(process.env.ELECTRON_RENDERER_URL).origin); }
    catch { /* Electron reports an invalid development URL while loading it. */ }
  }
  return origins;
}
