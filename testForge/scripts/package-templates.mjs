import { deflateRawSync } from "node:zlib";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatesRoot = resolve(root, "mcp_templates");
const outputRoot = resolve(root, "output", "mcp-templates");
const templateNames = ["c_server", "visascpi_server"];
const excludedSegments = new Set(["__pycache__", "venv", "run", "logs", "dist", "out", "output", "tmp", "tests"]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function collectFiles(directory, archivePrefix = "") {
  const files = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (excludedSegments.has(entry.name) || entry.name.endsWith(".pyc") || entry.name === "server.json") continue;
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const path = relative(directory, absolute).split(sep).join("/");
        files.push({ name: archivePrefix ? `${archivePrefix}/${path}` : path, data: await readFile(absolute) });
      }
    }
  }
  await visit(directory);
  return files;
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = 0x21;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function packageTemplate(templateName) {
  const templateRoot = resolve(templatesRoot, templateName);
  const runtimeRoot = resolve(templatesRoot, "runtime");
  const entries = [
    ...await collectFiles(templateRoot),
    ...await collectFiles(runtimeRoot, "runtime")
  ].sort((left, right) => left.name.localeCompare(right.name));
  const names = new Set(entries.map((entry) => entry.name));
  for (const required of [
    "install.ps1",
    "server.json.example",
    "app/pyproject.toml",
    "runtime/pyproject.toml",
    "runtime/powershell/stop.ps1",
    "runtime/src/testforge_runtime/server.py"
  ]) {
    if (!names.has(required)) throw new Error(`${templateName} package is missing ${required}`);
  }
  if ([...names].some((name) => name.includes("__pycache__") || name.includes("/venv/") || name.endsWith(".pyc"))) {
    throw new Error(`${templateName} package contains generated Python files`);
  }

  const archiveName = `testforge-${templateName.replaceAll("_", "-")}-template.zip`;
  const output = resolve(outputRoot, archiveName);
  if (!output.startsWith(`${outputRoot}${sep}`)) throw new Error(`Unsafe package output: ${output}`);
  await mkdir(outputRoot, { recursive: true });
  await writeFile(output, createZip(entries));
  return { output, entries: entries.length };
}

for (const templateName of templateNames) {
  const result = await packageTemplate(templateName);
  console.log(`Packaged ${basename(result.output)} (${result.entries} files)`);
}
