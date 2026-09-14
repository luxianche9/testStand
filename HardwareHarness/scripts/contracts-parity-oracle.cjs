// Test-only oracle. Load original contracts without editing/building their source files.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const compiler = createRequire(path.join(root, "package.json"))("typescript");
const cache = new Map();

function load(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const localRequire = createRequire(filename);
  const scopedRequire = (specifier) => specifier.startsWith(".")
    ? load(path.resolve(path.dirname(filename), specifier.replace(/\.js$/, ".ts")))
    : localRequire(specifier);
  const code = compiler.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: compiler.ModuleKind.CommonJS, target: compiler.ScriptTarget.ES2022 }
  }).outputText;
  new Function("require", "module", "exports", code)(scopedRequire, module, module.exports);
  return module.exports;
}

function decode(value) {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && "$js" in value) {
    return { undefined, NaN, Infinity, "-Infinity": -Infinity }[value.$js];
  }
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  return value;
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const output = JSON.parse(input).map((fixture) => {
    const [domain, name] = fixture.schema.split(".");
    const schema = load(path.join(root, "packages", "contracts", "src", `${domain}.ts`))[name];
    try {
      const data = schema.parse(decode(fixture.input));
      return { ...fixture, expected: { ok: true, data, json: `${JSON.stringify(data, null, 2)}\n` } };
    }
    catch (error) { return { ...fixture, expected: { ok: false, issues: error.issues, message: error.message } }; }
  });
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
});
