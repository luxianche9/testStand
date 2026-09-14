// Inventory original assertions without executing or changing the reference implementation.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const referenceIndex = process.argv.indexOf("--reference-root");
if (referenceIndex < 0 || !process.argv[referenceIndex + 1]) {
  throw new Error("Usage: specification-assertions.cjs --reference-root <historical-checkout/testForge>; output uses stdout");
}
const reference = path.resolve(process.argv[referenceIndex + 1]);
const baseline = JSON.parse(fs.readFileSync(path.join(root, "python/reports/ts-packages-results.json"), "utf8"));
const output = [];
const suites = [...baseline.testResults, { name: "apps/desktop/src/main/migrations.test.ts" }];
for (const suite of suites) {
  const filename = suite.name.startsWith("apps/") ? suite.name : "packages/" + suite.name.replaceAll("\\", "/").split("/packages/")[1];
  const bytes = fs.readFileSync(path.join(reference, filename));
  const source = ts.createSourceFile(filename, bytes.toString("utf8"), ts.ScriptTarget.Latest, true);
  const templates = [];
  function visit(node) {
    if (ts.isCallExpression(node) && /^(it|test)(?:\.|$)/.test(node.expression.getText(source))) {
      const title = node.arguments[0];
      const callback = node.arguments[1];
      if (title && ts.isStringLiteral(title) && callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const assertions = [];
        function collect(child) {
          if (ts.isCallExpression(child) && ["expect", "expectTypeOf"].includes(child.expression.getText(source))) {
            let statement = child;
            while (statement.parent && !ts.isStatement(statement)) statement = statement.parent;
            assertions.push({ line: source.getLineAndCharacterOfPosition(child.getStart(source)).line + 1, source: statement.getText(source) });
          }
          ts.forEachChild(child, collect);
        }
        collect(callback.body);
        templates.push({ title: title.text, assertions });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const cases = suite.assertionResults ?? templates.map(({ title }) => ({ title, ancestorTitles: ["global file storage"] }));
  for (const test of cases) {
    const exact = templates.filter((candidate) => candidate.title === test.title);
    const matches = exact.length ? exact : templates.filter((candidate) => {
      const escaped = candidate.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("%s", ".*?");
      return new RegExp(`^${escaped}$`).test(test.title);
    });
    if (matches.length !== 1 || !matches[0].assertions.length) throw new Error(`Ambiguous/missing original assertions: ${filename} :: ${test.title}`);
    output.push({ file: filename, title: test.title, ancestorTitles: test.ancestorTitles, template: matches[0].title,
      sourceHash: crypto.createHash("sha256").update(bytes).digest("hex"), assertions: matches[0].assertions });
  }
}
process.stdout.write(JSON.stringify(output, null, 2) + "\n");
