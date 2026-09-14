import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const removed = ["storage", "devices", "projects", "wiring", "orchestration", "application", "mcp-gateway"];
async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error; })) {
    if (entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(path));
    else files.push(path);
  }
  return files;
}
for (const name of removed) assert.deepEqual(await filesIn(join(workspace, "packages", name)), [], `Retired package ${name} still contains files outside ignored dependency caches`);
const store = join(workspace, "node_modules/.pnpm");
const asarPackage = (await readdir(store)).find((name) => name.startsWith("@electron+asar@"));
assert.ok(asarPackage, "The existing electron-builder asar dependency is missing");
const require = createRequire(import.meta.url);
const asar = require(join(store, asarPackage, "node_modules/@electron/asar"));
const archive = join(workspace, "dist/win-unpacked/resources/app.asar");
const entries = asar.listPackage(archive);
assert.deepEqual(entries.filter((path) => removed.some((name) => path.replaceAll("\\", "/").includes(`/@hardwareharness/${name}/`))), []);
const out = join(workspace, "apps/desktop/out");
const outputs = await filesIn(out);
for (const path of outputs) {
  const relative = join("out", path.slice(out.length + 1));
  assert.ok(asar.extractFile(archive, relative).equals(await readFile(path)), `Packaged output differs: ${relative}`);
}
for (const name of ["LICENSE.md", "README.md"]) {
  assert.ok((await readFile(join(workspace, "docs/shadcn", name))).equals(await readFile(join(workspace, "dist/win-unpacked/resources/third-party/shadcn", name))));
}
const artifacts = ["dist/HardwareHarness-0.1.0-windows-x64.exe", "dist/win-unpacked/resources/app.asar", "python/dist/hardwareharness-backend/hardwareharness-backend.exe"];
const records = [];
for (const path of artifacts) {
  const bytes = await readFile(join(workspace, path));
  records.push({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await access(join(workspace, "reports/shadcn/windows-installed-acceptance.txt"));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
const deleted = JSON.parse(await readFile(join(workspace, "reports/shadcn/deleted-files.json"), "utf8"));
await writeFile(join(workspace, "reports/shadcn/artifacts.json"), JSON.stringify({ referenceRevision: revision, deletedTrackedFiles: deleted.length, retiredBusinessPackages: removed, asarBusinessPackages: 0, matchingBuiltFiles: outputs.length, shadcnNoticesMatch: true, artifacts: records }, null, 2) + "\n");
console.log(`Verified ${outputs.length} packaged build files, seven retired packages absent, and bundled shadcn notices.`);
