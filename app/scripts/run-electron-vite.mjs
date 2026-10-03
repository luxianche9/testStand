import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const workspace = path.resolve(import.meta.dirname, "..");
const desktopDir = path.join(workspace, "apps", "desktop");
const require = createRequire(path.join(desktopDir, "package.json"));
const electronVitePackage = require.resolve("electron-vite/package.json");
const electronViteCli = path.join(path.dirname(electronVitePackage), "bin", "electron-vite.js");
const environment = { ...process.env };

// Some Electron-hosted terminals export this for their own helper processes.
// It must not leak into the application being developed, or Electron starts as
// plain Node.js and cannot expose its main-process APIs.
delete environment.ELECTRON_RUN_AS_NODE;

const electronPackagePath = require.resolve("electron/package.json");
const electronPackageDir = path.dirname(electronPackagePath);

function electronExecutable() {
  const override = environment.ELECTRON_OVERRIDE_DIST_PATH;
  const executable = process.platform === "win32" ? "electron.exe" : "electron";
  if (override) return path.join(override, executable);

  const pathFile = path.join(electronPackageDir, "path.txt");
  if (!existsSync(pathFile)) return undefined;
  return path.join(electronPackageDir, "dist", readFileSync(pathFile, "utf8").trim());
}

function hasElectronBinary() {
  const executable = electronExecutable();
  return Boolean(executable && existsSync(executable));
}

async function ensureElectronBinary() {
  if (hasElectronBinary()) return;

  const installer = spawnSync(process.execPath, [path.join(electronPackageDir, "install.js")], {
    cwd: electronPackageDir,
    env: environment,
    stdio: "inherit"
  });
  if (!installer.error && installer.status === 0 && hasElectronBinary()) return;

  // extract-zip 2.x can stop after the first entry under newer Node.js builds.
  // Electron itself is Windows-only in this project, so use the system tar as a
  // deterministic fallback when a moved or partially installed node_modules is
  // missing Electron's path.txt/binary.
  if (process.platform !== "win32") {
    throw new Error("Electron is not installed. Reinstall dependencies with Node.js 22 LTS.");
  }

  const electronPackage = JSON.parse(readFileSync(electronPackagePath, "utf8"));
  const electronRequire = createRequire(electronPackagePath);
  const { downloadArtifact } = electronRequire("@electron/get");
  const archive = await downloadArtifact({
    version: electronPackage.version,
    artifactName: "electron",
    platform: process.env.npm_config_platform || process.platform,
    arch: process.env.npm_config_arch || process.arch
  });

  const staging = path.join(electronPackageDir, `.dist-repair-${process.pid}`);
  const destination = path.join(electronPackageDir, "dist");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  try {
    const extraction = spawnSync("tar.exe", ["-xf", archive, "-C", staging], {
      env: environment,
      stdio: "inherit"
    });
    const stagedExecutable = path.join(staging, "electron.exe");
    if (extraction.error || extraction.status !== 0 || !existsSync(stagedExecutable)) {
      throw extraction.error ?? new Error("Electron archive extraction did not produce electron.exe");
    }

    rmSync(destination, { recursive: true, force: true });
    renameSync(staging, destination);
    writeFileSync(path.join(electronPackageDir, "path.txt"), "electron.exe");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  if (!hasElectronBinary()) throw new Error("Electron binary repair failed. Reinstall dependencies with Node.js 22 LTS.");
}

await ensureElectronBinary();

const result = spawnSync(process.execPath, [electronViteCli, ...process.argv.slice(2)], {
  cwd: desktopDir,
  env: environment,
  stdio: "inherit"
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
