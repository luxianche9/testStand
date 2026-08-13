import { spawnSync } from "node:child_process";
import { delimiter, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const candidates = process.env.TESTFORGE_PYTHON
  ? [[process.env.TESTFORGE_PYTHON, []]]
  : process.platform === "win32" ? [["python", []], ["py", ["-3"]]] : [["python3", []], ["python", []]];

const selected = candidates.find(([command, prefix]) => spawnSync(command, [...prefix, "--version"], { stdio: "ignore" }).status === 0);
if (!selected) throw new Error("Python 3 was not found. Set TESTFORGE_PYTHON to the interpreter path.");

const [command, prefix] = selected;
const runtimePath = resolve(root, "mcp_templates/runtime/src");
const suites = [
  {
    directory: "mcp_templates/runtime/tests",
    pythonPath: [runtimePath, process.env.PYTHONPATH]
  },
  ...["c_server", "visascpi_server"].map((template) => ({
    directory: `mcp_templates/${template}/tests`,
    pythonPath: [runtimePath, resolve(root, `mcp_templates/${template}/app/src`), process.env.PYTHONPATH]
  }))
];

for (const suite of suites) {
  const result = spawnSync(command, [...prefix, "-m", "unittest", "discover", "-s", suite.directory, "-p", "test_*.py"], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: suite.pythonPath.filter(Boolean).join(delimiter) },
    stdio: "inherit"
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
