// One version for a release: the workspace, the desktop app (installer name), the contracts package
// and the Python backend (handshake, MCP server info) must all say the same thing.
import { readFile } from "node:fs/promises";

const workspace = new URL("..", import.meta.url);
const read = async (path) => readFile(new URL(path, workspace), "utf8");
const versions = {
  "package.json": JSON.parse(await read("package.json")).version,
  "apps/desktop/package.json": JSON.parse(await read("apps/desktop/package.json")).version,
  "packages/contracts/package.json": JSON.parse(await read("packages/contracts/package.json")).version,
  "python/pyproject.toml": /^version = "([^"]+)"/m.exec(await read("python/pyproject.toml"))?.[1]
};
const distinct = new Set(Object.values(versions));
if (distinct.size !== 1 || distinct.has(undefined)) {
  throw new Error(`Versions differ:\n${Object.entries(versions).map(([file, value]) => `  ${file}: ${value}`).join("\n")}`);
}
console.log(`testStand version ${[...distinct][0]} is consistent.`);
