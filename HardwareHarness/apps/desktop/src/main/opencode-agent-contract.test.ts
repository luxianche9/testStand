import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { HARDWAREHARNESS_AGENT_INSTRUCTIONS, openCodeConfig } from "./opencode-runtime.js";

const execFileAsync = promisify(execFile);

// Exercise the exact bundled executable's config parser and resolved agent, without a model request.
it.skipIf(process.platform !== "win32")("the bundled OpenCode accepts and resolves HH primary-agent instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "hardwareharness-agent-contract-"));
  const binary = fileURLToPath(new URL("../../node_modules/opencode-windows-x64-baseline/bin/opencode.exe", import.meta.url));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPENCODE_CONFIG_CONTENT: openCodeConfig("http://127.0.0.1:1/mcp", { baseUrl: "http://127.0.0.1:1/v1", model: "contract-test" }),
    HARDWAREHARNESS_MCP_TOKEN: "contract-test-placeholder",
    HARDWAREHARNESS_LLM_API_KEY: "contract-test-placeholder"
  };
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_CONFIG_DIR;
  try {
    const options = { cwd: root, env, windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 };
    const { stdout } = await execFileAsync(binary, ["--pure", "debug", "config"], options);
    const configuration = JSON.parse(stdout);
    expect(configuration.default_agent).toBe("build");
    expect(configuration.agent.build.prompt).toBe(HARDWAREHARNESS_AGENT_INSTRUCTIONS);
    expect(configuration.agent.plan.prompt).toBe(HARDWAREHARNESS_AGENT_INSTRUCTIONS);
    const agent = await execFileAsync(binary, ["--pure", "debug", "agent", "build"], options);
    const resolved = JSON.parse(agent.stdout);
    expect(resolved.name).toBe("build");
    expect(resolved.mode).toBe("primary");
    expect(resolved.prompt).toBe(HARDWAREHARNESS_AGENT_INSTRUCTIONS);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 65_000);
