// Capture the complete desktop forwarding specification for Python's dispatch tests.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "apps/desktop/src/main/python-facade.test.ts"), "utf8");
const constants = source.slice(source.indexOf("const id ="), source.indexOf('describe("unchanged desktop facade'));
const javascript = ts.transpile(constants, { target: ts.ScriptTarget.ES2022 });
const routes = vm.runInNewContext(javascript + ";routes", { Uint8Array });
const output = routes.filter(([, , target]) => target?.startsWith("application.")).map(([path, , method, args]) => ({ path, method, args }));
const json = JSON.stringify(output, (_key, value) => {
  if (value === undefined) return { __undefined__: true };
  if (value instanceof Uint8Array) return { __bytes__: Array.from(value) };
  return value;
}, 2) + "\n";
fs.writeFileSync(path.join(root, "python/tests/host/facade-calls.json"), json, "utf8");
console.log(`Captured ${output.length} desktop-to-Python forwarding cases`);
