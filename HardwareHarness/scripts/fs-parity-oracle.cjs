const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardwareharness-fs-oracle-"));
  const result = [];
  try {
    await fs.writeFile(path.join(root, "file"), "data");
    await fs.mkdir(path.join(root, "directory"));
    await fs.writeFile(path.join(root, "readonly"), "data");
    await fs.chmod(path.join(root, "readonly"), 0o444);
    const cases = [
      ["stat-missing", () => fs.stat(path.join(root, "missing"))],
      ["read-missing", () => fs.readFile(path.join(root, "missing"), "utf8")],
      ["read-directory", () => fs.readFile(path.join(root, "directory"), "utf8")],
      ["read-parent-file", () => fs.readFile(path.join(root, "file", "child"), "utf8")],
      ["stat-parent-file", () => fs.stat(path.join(root, "file", "child"))],
      ["mkdir-parent-file", () => fs.mkdir(path.join(root, "file", "child"), { recursive: true })],
      ["mkdir-existing-file", () => fs.mkdir(path.join(root, "file"), { recursive: true })],
      ["scandir-file", () => fs.readdir(path.join(root, "file"), { withFileTypes: true })],
      ["rename-missing", () => fs.rename(path.join(root, "missing"), path.join(root, "target"))],
      ["rename-to-directory", () => fs.rename(path.join(root, "file"), path.join(root, "directory"))],
      ["open-existing", () => fs.open(path.join(root, "file"), "wx")],
      ["unlink-directory", () => fs.unlink(path.join(root, "directory"))],
      ["rm-directory", () => fs.rm(path.join(root, "directory"), { force: true })],
      ["rm-readonly", () => fs.rm(path.join(root, "readonly"), { force: true })],
      ["rm-missing", () => fs.rm(path.join(root, "missing"), { force: true })],
      ["read-null", () => fs.readFile(path.join(root, "a\0b"), "utf8")]
    ];
    for (const [name, run] of cases) {
      try { await run(); result.push({ name, result: "success" }); }
      catch (error) { result.push({ name, message: error.message.replaceAll(root, "<ROOT>"), code: error.code, syscall: error.syscall }); }
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith("hardwareharness-fs-oracle-")) throw new Error("Unsafe oracle temporary directory");
    await fs.rm(root, { recursive: true, force: true });
  }
})();
