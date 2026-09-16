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
const root = await mkdtemp(join(tmpdir(), "HH 发行接口 "));
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
    if (/^(PYTHON|UV_|VIRTUAL_ENV|HARDWAREHARNESS_)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    PATH: join(process.env.SYSTEMROOT ?? "C:\\Windows", "System32"),
    UV_OFFLINE: "1", UV_CACHE_DIR: join(root, "empty-cache"), UV_PYTHON_DOWNLOADS: "never",
    PYTHONUTF8: "1"
  });
  child = spawn(join(backend, "hardwareharness-backend.exe"), [], {
    cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
  });
  console.log(`Frozen smoke: relocated backend PID ${child.pid} at ${root}`);
  host = createDesktopHost(child);
  await host.call("backend.initialize", {
    userData: join(root, "profile"), gatewayPort: 0, locale: "zh-CN",
    integrationTestMode: true, gatewayTestToken: token
  });
  console.log("Frozen smoke: backend initialized; opening isolated project");
  const human = { actor: "human", source: "desktop" };
  await host.call("application.projects.initializeFolder", { args: [human, project] });
  console.log("Frozen smoke: project ready; checking public MCP interface");
  report = await verifyAgentInterface(host.state().gateway.endpoint, token);
  await host.call("backend.shutdown");
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
    await Promise.race([host.exited, new Promise((done) => setTimeout(done, 5000))]);
    if (child.exitCode === null) {
      child.kill();
      await host.exited;
    }
  }
  // root is the absolute directory returned by mkdtemp; all disposable resources stay under it.
  await rm(root, { recursive: true, force: true });
}

function createDesktopHost(process) {
  let state = {};
  let sequence = 0;
  let stderr = "";
  const pending = new Map();
  const lines = createInterface({ input: process.stdout });
  process.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16000); });
  const send = (message) => process.stdin.write(JSON.stringify(message) + "\n");
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method && message.id) {
      const params = decode(message.params);
      // This test host stores only generated test credentials; it never reads the user's secrets.
      const result = message.method === "host.safeStorage.encrypt"
        ? Buffer.from(`test-profile:${params.value}`) : params.value.toString("utf8").slice(13);
      send({ jsonrpc: "2.0", id: message.id, result: encode(result) });
    } else if (!message.method) {
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      clearTimeout(handler.timer);
      if (message.state) state = decode(message.state);
      if (message.error) handler.reject(new Error(JSON.stringify(decode(message.error))));
      else handler.resolve(decode(message.result));
    }
  });
  const exited = new Promise((resolveExit) => process.once("exit", (code) => {
    for (const handler of pending.values()) {
      clearTimeout(handler.timer);
      handler.reject(new Error(`Backend exited ${code}: ${stderr}`));
    }
    resolveExit(code);
  }));
  return {
    state: () => state, exited,
    call: (method, params = null) => new Promise((resolveCall, reject) => {
      const id = `release:${++sequence}`;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 60000);
      pending.set(id, { resolve: resolveCall, reject, timer });
      send({ jsonrpc: "2.0", id, method, params: encode(params) });
    })
  };
}

function encode(value) {
  if (value === null) return ["null"];
  if (value === undefined) return ["undefined"];
  if (Buffer.isBuffer(value)) return ["bytes", value.toString("base64")];
  if (Array.isArray(value)) return ["array", value.map(encode)];
  if (typeof value === "object") return ["object", Object.entries(value).map(([key, item]) => [key, encode(item)])];
  return [typeof value, value];
}

function decode([tag, value]) {
  if (tag === "null") return null;
  if (tag === "undefined") return undefined;
  if (tag === "bytes") return Buffer.from(value, "base64");
  if (tag === "array") return value.map(decode);
  if (tag === "object") return Object.fromEntries(value.map(([key, item]) => [key, decode(item)]));
  return value;
}
