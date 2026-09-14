import { readFile, readdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("..", import.meta.url));
const repository = resolve(workspace, "..");
const retired = /test[\s_-]?forge|\.tfhw/i;
const excluded = new Set(["node_modules", ".venv", "venv", "dist", "out", "build", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", ".git", "run", "logs", "firmware"]);
const text = /\.(?:[cm]?[jt]sx?|py|json|toml|ya?ml|md|ps1|css|html|txt|spec|lock)$/i;
const violations = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.name.endsWith(".egg-info") || entry.isSymbolicLink()) continue;
    const path = resolve(directory, entry.name);
    if (retired.test(entry.name)) violations.push(relative(repository, path));
    if (entry.isDirectory()) await visit(path);
    else if (text.test(entry.name) && retired.test(await readFile(path, "utf8"))) violations.push(relative(repository, path));
  }
}

for (const directory of ["apps", "packages", "python/src"]) await visit(resolve(workspace, directory));
await visit(resolve(repository, "mcp_servers"));
for (const name of ["package.json", "pnpm-lock.yaml", "python/pyproject.toml", "python/uv.lock", "python/backend.spec", "README.md"]) {
  if (retired.test(await readFile(resolve(workspace, name), "utf8"))) violations.push(name);
}
if (violations.length) throw new Error(`Retired branding in active files:\n${violations.join("\n")}`);
console.log("HardwareHarness branding verified across desktop, backend, contracts and MCP services.");
