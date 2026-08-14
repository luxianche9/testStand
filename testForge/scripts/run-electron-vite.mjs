import { spawnSync } from "node:child_process";
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

const result = spawnSync(process.execPath, [electronViteCli, ...process.argv.slice(2)], {
  cwd: desktopDir,
  env: environment,
  stdio: "inherit"
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
