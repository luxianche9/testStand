// Rebuild only the historical renderer for visual comparison; no TS business backend is copied.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const revision = process.argv[2];
if (!revision || !/^[a-f0-9]{40}$/.test(revision)) throw new Error("Pass the full historical Git revision");
const repository = resolve(workspace, "..");
const scratch = await mkdtemp(join(tmpdir(), "testforge-renderer-reference-"));
const roots = ["testForge/apps/desktop/src/renderer", "testForge/apps/desktop/src/shared"];
const files = execFileSync("git", ["ls-tree", "-r", "--name-only", revision, "--", ...roots], { cwd: repository, encoding: "utf8" }).trim().split("\n");
for (const file of files) {
  const target = resolve(scratch, file);
  if (!target.startsWith(scratch + "/") && !target.startsWith(scratch + "\\")) throw new Error("Reference path escaped temporary directory");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, execFileSync("git", ["show", `${revision}:${file}`], { cwd: repository }));
}
const desktop = join(scratch, "testForge/apps/desktop");
await symlink(join(workspace, "apps/desktop/node_modules"), join(desktop, "node_modules"), "junction");
const require = createRequire(join(workspace, "apps/desktop/package.json"));
const { build, defaultClientConditions } = await import(pathToFileURL(require.resolve("vite")).href);
const { default: react } = await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href);
const { default: tailwindcss } = await import(pathToFileURL(require.resolve("@tailwindcss/vite")).href);
const output = join(scratch, "renderer-dist");
await build({
  configFile: false, root: join(desktop, "src/renderer"), base: "./",
  resolve: { conditions: ["testforge-source", ...defaultClientConditions] },
  plugins: [react(), tailwindcss()], esbuild: { minifyIdentifiers: false },
  build: { outDir: output, minify: "esbuild" }
});
await writeFile(join(workspace, "reports/shadcn/renderer-reference.json"), JSON.stringify({ revision, files: files.length, output }, null, 2) + "\n");
console.log(`Historical renderer: ${output}`);
