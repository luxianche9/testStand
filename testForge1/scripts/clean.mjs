import { readdir, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = ["apps/desktop/out", "dist", "output"];

for (const parent of ["apps", "packages"]) {
  const entries = await readdir(resolve(root, parent), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) if (entry.isDirectory()) targets.push(`${parent}/${entry.name}/dist`);
}

for (const relative of targets) {
  const target = resolve(root, relative);
  if (target === root || !target.startsWith(`${root}${sep}`)) throw new Error(`Refusing to clean unsafe path: ${target}`);
  await rm(target, { recursive: true, force: true });
}
