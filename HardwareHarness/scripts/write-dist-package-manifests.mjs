// Writes a { "type": "commonjs" } manifest into each workspace package's dist/
// so the CommonJS output emitted by tsconfig.build.json is interpreted as CJS
// even though the packages themselves are "type": "module" (source-first ESM).
import { readdir, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";

const packagesRoot = resolve(import.meta.dirname, "..", "packages");
for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dist = join(packagesRoot, entry.name, "dist");
  try { await access(dist); } catch { continue; }
  await writeFile(join(dist, "package.json"), JSON.stringify({ type: "commonjs" }) + "\n");
}
console.log("dist package manifests written");
