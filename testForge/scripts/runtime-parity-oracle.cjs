// Test-only oracle: execute unmodified original TypeScript services.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const workspace = path.resolve(__dirname, "..");
const referenceIndex = process.argv.indexOf("--reference-root");
if (referenceIndex < 0 || !process.argv[referenceIndex + 1]) {
  throw new Error("Usage: runtime-parity-oracle.cjs --reference-root <historical-checkout/testForge>; input and output use stdin/stdout");
}
const root = path.resolve(process.argv[referenceIndex + 1]);
const compiler = createRequire(path.join(workspace, "package.json"))("typescript");
const cache = new Map();
let sequence = 0;
let clock = 0;
const NativeDate = Date;
class FixedDate extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
}

function load(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const localRequire = createRequire(filename);
  function scopedRequire(specifier) {
    if (specifier === "node:crypto") return { ...localRequire(specifier), randomUUID: () => `uuid-${++sequence}` };
    if (specifier.startsWith("@testforge/contracts/")) {
      return load(path.join(root, "packages/contracts/src", `${specifier.split("/").at(-1)}.ts`));
    }
    return specifier.startsWith(".")
      ? load(path.resolve(path.dirname(filename), specifier.replace(/\.js$/, ".ts")))
      : localRequire(specifier);
  }
  const code = compiler.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: compiler.ModuleKind.CommonJS, target: compiler.ScriptTarget.ES2022 }
  }).outputText;
  new Function("require", "module", "exports", code)(scopedRequire, module, module.exports);
  return module.exports;
}

async function files(directory) {
  const result = {};
  async function walk(current) {
    for (const entry of (await fsp.readdir(current, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else result[path.relative(directory, filename).split(path.sep).join("/")] = await fsp.readFile(filename, "utf8");
    }
  }
  await walk(directory);
  return result;
}

async function execute(fixture) {
  const { toWireError } = load(path.join(root, "packages/contracts/src/errors.ts"));
  const results = [];
  if (fixture.domain === "storage") {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "testforge-ts-oracle-"));
    try {
      for (const [relative, content] of Object.entries(fixture.files ?? {})) {
        const filename = path.join(directory, relative);
        await fsp.mkdir(path.dirname(filename), { recursive: true });
        await fsp.writeFile(filename, content, "utf8");
      }
      const writes = [];
      const { ProjectRunLogStore } = load(path.join(root, "packages/storage/src/run-log-store.ts"));
      const service = new ProjectRunLogStore({ ...fixture.options, onWrite: (write) => writes.push(write) });
      for (const action of fixture.actions) {
        try { results.push({ result: await service[action.method](directory, ...action.args) ?? null }); }
        catch (error) { results.push({ error: toWireError(error) }); }
        if (action.inspect) results.at(-1).files = await files(directory);
      }
      return { results, files: await files(directory), writes };
    } finally {
      if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(directory).startsWith("testforge-ts-oracle-")) throw new Error("Unsafe oracle temporary directory");
      await fsp.rm(directory, { recursive: true, force: true });
    }
  }
  if (fixture.domain !== "wiring") throw new Error(`Unknown fixture domain: ${fixture.domain}`);
  sequence = 0;
  clock = NativeDate.parse(fixture.now);
  global.Date = FixedDate;
  try {
    let wiring = structuredClone(fixture.wiring);
    let dirty = false;
    const notifications = [];
    let projectNotifications = 0;
    const projects = {
      wiring: () => structuredClone(wiring),
      document: () => ({ dirty }),
      updateWiring: (value) => { wiring = structuredClone(value); dirty = true; return { dirty }; }
    };
    const catalog = {
      getHardware: (id) => {
        const value = fixture.hardware.find((hardware) => hardware.hardwareId === id);
        if (!value) throw new Error(`Unknown hardwareId: ${id}`);
        return structuredClone(value);
      },
      resolvePort: (ref) => {
        const [id, portId] = ref.split(".");
        const hardware = catalog.getHardware(id);
        const port = hardware.ports.find((value) => value.portId === portId);
        if (!port) throw new Error(`Unknown portRef: ${ref}`);
        return { hardware, port };
      },
      validatePins: (a, b, pins) => {
        for (const pin of pins) for (const [ref, side] of [[a, "a"], [b, "b"]]) {
          if (!catalog.resolvePort(ref).port.pins.some((value) => value.pinId === pin[side])) throw new Error(`Port ${ref} has no pin ${pin[side]}`);
        }
      },
      warningsForPorts: (a, b) => [`Missing image: ${a}`, `Missing image: ${b}`]
    };
    const { ProjectWiringService } = load(path.join(root, "packages/wiring/src/project-wiring-service.ts"));
    const service = new ProjectWiringService(projects, catalog);
    service.setNotifier((task) => notifications.push(task));
    service.setProjectNotifier(() => projectNotifications++);
    for (const action of fixture.actions) {
      if (action.method === "advance") { clock += action.args[0]; results.push({ result: null }); continue; }
      try { results.push({ result: await service[action.method](...action.args) ?? null }); }
      catch (error) { results.push({ error: toWireError(error) }); }
      if (action.inspect) results.at(-1).wiring = structuredClone(wiring);
    }
    return { results, wiring, dirty, notifications, projectNotifications };
  } finally { global.Date = NativeDate; }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", async () => {
  const output = [];
  for (const fixture of JSON.parse(input)) {
    const expected = await execute(fixture);
    output.push({ ...fixture, expected, expectedJson: JSON.stringify(expected, null, 2) + "\n" });
  }
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
});
