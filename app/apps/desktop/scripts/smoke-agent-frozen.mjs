import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { verifyAgentInterface } from "./agent-release-smoke.mjs";

const [backendInput, reportInput] = process.argv.slice(2);
assert.ok(backendInput && reportInput, "Usage: node smoke-agent-frozen.mjs <frozen-backend-directory> <report.json>");
const root = await mkdtemp(join(tmpdir(), "testStand 发行接口 "));
const backend = join(root, "resources", "backend");
const project = join(root, "用户工程 中文");
const token = randomUUID();
let child;
let host;
let report;
try {
  await cp(resolve(backendInput), backend, { recursive: true });
  await mkdir(project);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(PYTHON|UV_|VIRTUAL_ENV|TESTSTAND_)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    PATH: join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32"),
    UV_OFFLINE: "1", UV_CACHE_DIR: join(root, "empty-cache"), UV_PYTHON_DOWNLOADS: "never",
    PYTHONUTF8: "1"
  });
  env.TESTSTAND_GATEWAY_TEST_TOKEN = token;
  child = spawn(join(backend, "teststand-backend.exe"), [
    "--user-data", join(root, "profile"), "--gateway-port", "0", "--integration-test-mode"
  ], { cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  console.log(`Frozen smoke: relocated backend PID ${child.pid} at ${root}`);
  host = await connectDesktopHost(child);
  console.log("Frozen smoke: backend listening; opening isolated project");
  await host.invoke("projects.initializeFolder", { rootPath: project });
  console.log("Frozen smoke: project ready; checking public MCP interface");
  const dashboard = await host.invoke("system.dashboard");
  report = await verifyAgentInterface(dashboard.gateway.endpoint, token);
  // Closing stdin is the shutdown signal.
  child.stdin.end();
  const code = await host.exited;
  assert.equal(code, 0);
  report = {
    ...report, frozenBackend: true, relocatedResources: true, machinePythonAndUvRemovedFromPath: true,
    projectPathContainsChineseAndSpaces: true, uvOffline: true, freshCache: true,
    bootstrap: "Desktop protocol only for isolated profile/project setup; task uses public MCP",
    backendExitCode: code, backendStopped: true,
    physicalNetworkDisconnected: false, independentCleanWindowsVerified: false
  };
  await mkdir(dirname(resolve(reportInput)), { recursive: true });
  await writeFile(resolve(reportInput), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, report: resolve(reportInput), tools: report.publicTools, hardwareInvoked: false }));
} finally {
  if (child && child.exitCode === null) {
    child.stdin.end();
    await Promise.race([host?.exited, new Promise((done) => setTimeout(done, 5000))]);
    if (child.exitCode === null) {
      child.kill();
      await host?.exited;
    }
  }
  // root is the absolute directory returned by mkdtemp; all disposable resources stay under it.
  await rm(root, { recursive: true, force: true });
}

/** Plays Electron main and the renderer: reads the one-line handshake, then speaks the local HTTP API. */
async function connectDesktopHost(process) {
  let stderr = "";
  process.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16000); });
  const exited = new Promise((resolveExit) => process.once("exit", (code) => resolveExit(code)));
  const lines = createInterface({ input: process.stdout });
  const handshake = await new Promise((resolveLine, reject) => {
    const timer = setTimeout(() => reject(new Error(`Backend did not start: ${stderr}`)), 60000);
    lines.once("line", (line) => { clearTimeout(timer); resolveLine(JSON.parse(line)); });
    exited.then((code) => reject(new Error(`Backend exited ${code}: ${stderr}`)));
  });
  const url = `http://127.0.0.1:${handshake.port}`;
  const post = async (operation, body) => {
    const response = await fetch(`${url}/api/ops/${operation}`, {
      method: "POST", signal: AbortSignal.timeout(60000),
      headers: { authorization: `Bearer ${handshake.token}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`${operation} failed: ${JSON.stringify(result.error)} ${stderr}`);
    return result;
  };
  return {
    exited,
    invoke: (operation, body = {}) => post(operation, body)
  };
}
