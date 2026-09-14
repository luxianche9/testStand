import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceRoots = [resolve(root, "packages"), resolve(root, "apps", "desktop", "src")];
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const removedWorkspacePackageNames = new Set(["core", "shared", "storage", "devices", "projects", "wiring", "orchestration", "application", "mcp-gateway"]);
const importPattern = /(?:from\s*|import\s*\(|require\s*\()\s*["'](@testforge\/[^"']+)["']/g;
const violations = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      const source = await readFile(path, "utf8");
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        const parts = specifier.split("/");
        if (removedWorkspacePackageNames.has(parts[1])) {
          violations.push(`${path}: removed package import ${specifier}`);
          continue;
        }
        if (parts[1] === "contracts") {
          if (parts.length !== 3) violations.push(`${path}: contracts must use one explicit public subpath (${specifier})`);
        } else if (parts.length !== 2) {
          violations.push(`${path}: workspace package deep import is forbidden (${specifier})`);
        }
      }
    }
  }
}

for (const sourceRoot of sourceRoots) await visit(sourceRoot);
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Workspace imports use only public package entry points.");
}
