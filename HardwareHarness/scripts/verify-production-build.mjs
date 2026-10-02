import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpmScript = process.env.npm_execpath;

function run(args) {
  const result = pnpmScript
    ? spawnSync(process.execPath, [pnpmScript, ...args], { cwd: root, stdio: "inherit", shell: false })
    : spawnSync("pnpm", args, { cwd: root, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function trackedPaths() {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(result.stderr || "git ls-files failed");
  return result.stdout.split("\0").filter(Boolean).sort();
}

async function snapshotTrackedFiles() {
  const snapshot = new Map();
  for (const relative of trackedPaths()) {
    const path = resolve(root, relative);
    try {
      const info = await lstat(path);
      const content = info.isSymbolicLink() ? Buffer.from(await readlink(path)) : await readFile(path);
      snapshot.set(relative, `${info.mode}:${createHash("sha256").update(content).digest("hex")}`);
    } catch (error) {
      if (error?.code === "ENOENT") snapshot.set(relative, "<missing>");
      else throw error;
    }
  }
  return snapshot;
}

function changedFiles(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}

async function verifyRendererChunks() {
  const rendererRoot = resolve(root, "apps", "desktop", "out", "renderer");
  const html = await readFile(resolve(rendererRoot, "index.html"), "utf8");
  const match = html.match(/<script[^>]+src="\.\/(assets\/[^"?]+\.js)"/);
  if (!match?.[1]) throw new Error("Could not identify the initial Renderer entry chunk");
  const entry = await readFile(resolve(rendererRoot, match[1]), "utf8");
  if (Buffer.byteLength(entry) > 1_000_000) throw new Error(`Initial Renderer chunk is unexpectedly large: ${Buffer.byteLength(entry)} bytes`);

  const forbidden = ["AssistantRuntimeProvider", "PatchDiff", "createHighlighter", "bundledLanguages", "OpenCodeRuntime"];
  const leaked = forbidden.filter((token) => entry.includes(token));
  if (leaked.length) throw new Error(`Initial Renderer chunk contains lazy Agent/diff/grammar code: ${leaked.join(", ")}`);

  const assetsRoot = resolve(rendererRoot, "assets");
  const assistantChunks = (await readdir(assetsRoot)).filter((name) => /^assistant-.*\.js$/.test(name));
  if (!assistantChunks.length) throw new Error("Assistant was not emitted as a separate lazy chunk");
  const assistantCode = (await Promise.all(assistantChunks.map((name) => readFile(resolve(assetsRoot, name), "utf8")))).join("\n");
  if (!forbidden.some((token) => assistantCode.includes(token))) throw new Error("Assistant lazy chunk does not contain the expected Agent/diff implementation");

  console.log(`Renderer entry ${match[1]} is ${Buffer.byteLength(entry)} bytes; Agent code is isolated in ${assistantChunks.join(", ")}.`);
}

async function verifySourceFirstBundles() {
  const artifacts = [
    resolve(root, "apps", "desktop", "out", "main", "index.js"),
    resolve(root, "apps", "desktop", "out", "preload", "index.cjs")
  ];
  const leaked = [];
  for (const artifact of artifacts) {
    const code = await readFile(artifact, "utf8");
    if (/\brequire\(\s*["']@hardwareharness\//.test(code)) leaked.push(artifact);
  }
  if (leaked.length) {
    throw new Error(`Source-first workspace imports were externalized from Electron bundles:\n${leaked.join("\n")}`);
  }
  const mainCode = await readFile(artifacts[0], "utf8");
  const businessImplementations = ["class DeviceStore", "class DeviceService", "class ProjectService", "class ProjectWiringService", "class TaskOrchestrationService", "class HardwareHarnessApplication", "class LocalMcpGateway", "class SettingsStore", "class SecretStore", "class ProjectRunLogStore"];
  const businessLeaks = businessImplementations.filter((name) => mainCode.includes(name));
  if (businessLeaks.length) throw new Error(`Python-owned business implementation leaked into Main: ${businessLeaks.join(", ")}`);
  if (!mainCode.includes("--gateway-port") || !mainCode.includes("hardwareharness-backend.exe")) throw new Error("Main does not contain the Python child-process integration");
  console.log("Electron Main and Preload contain no externalized workspace package imports.");
}

const before = await snapshotTrackedFiles();
run(["clean"]);
run(["-r", "build"]);
await verifyRendererChunks();
await verifySourceFirstBundles();
const after = await snapshotTrackedFiles();
const changed = changedFiles(before, after);
if (changed.length) throw new Error(`Production build modified tracked files:\n${changed.join("\n")}`);
console.log("Production build left all tracked files unchanged.");
