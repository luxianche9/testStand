// Build a testStand release into <repository>/release/<version>/ (outside app/dist, which every
// build cleans):
//   testStand-<version>-windows-x64.exe   the installer (NSIS, unsigned)
//   devices/<type>-<version>.tsdev         one device package per adapter in devices/adapters
//   SHA256SUMS.txt, RELEASE.md
// Steps: version check, frozen backend + desktop + installer, device packages (tests, --check,
// wheel), then the packaged smoke test against the unpacked app and those device packages.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("..", import.meta.url));
const repository = resolve(workspace, "..");
const dist = resolve(workspace, "dist");
const version = JSON.parse(await readFile(resolve(workspace, "apps/desktop/package.json"), "utf8")).version;
const release = resolve(repository, "release", version);

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
}

const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

run("node", ["scripts/check-version.mjs"], { cwd: workspace });
await rm(release, { recursive: true, force: true });
await mkdir(resolve(release, "devices"), { recursive: true });

run("pnpm", ["package:win"], { cwd: workspace });
run("uv", ["run", "--project", "devices", "python", "devices/pack.py", "--all", "--out", resolve(release, "devices")],
  { cwd: repository });
run("node", ["scripts/smoke-packaged.mjs"], {
  cwd: resolve(workspace, "apps/desktop"),
  env: { ...process.env, TESTSTAND_SMOKE_DEVICE_PACKAGES: resolve(release, "devices") }
});

const installer = `testStand-${version}-windows-x64.exe`;
await copyFile(resolve(dist, installer), resolve(release, installer));
const packages = (await readdir(resolve(release, "devices"))).filter((name) => name.endsWith(".tsdev")).sort();
const files = [installer, ...packages.map((name) => `devices/${name}`)];
const sums = await Promise.all(files.map(async (name) => `${await sha256(resolve(release, name))}  ${name}`));
await writeFile(resolve(release, "SHA256SUMS.txt"), sums.join("\n") + "\n");

const changelog = await readFile(resolve(repository, "CHANGELOG.md"), "utf8");
const section = changelog.split(/^## /m).find((part) => part.startsWith(`${version} `) || part.startsWith(`${version}\n`));
const notes = await readFile(resolve(workspace, "scripts/release-notes.md"), "utf8");
await writeFile(resolve(release, "RELEASE.md"), notes
  .replaceAll("{{version}}", version)
  .replace("{{installer}}", installer)
  .replace("{{packages}}", packages.map((name) => `- \`devices/${name}\``).join("\n"))
  .replace("{{changes}}", section ? section.slice(section.indexOf("\n") + 1).trim() : "（见 CHANGELOG.md）"));
console.log(`\nRelease ${version} in ${release}:\n${files.map((name) => `  ${basename(name)}`).join("\n")}`);
