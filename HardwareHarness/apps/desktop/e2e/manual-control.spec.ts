import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHardwareMcpFixture, type HardwareMcpFixture } from "./fixtures/hardware-mcp.js";
import { reloadAfterLeave, rendererReady } from "./renderer.js";

const desktopDir = resolve(import.meta.dirname, "..");
const gatewayPort = 18086;
const gatewayToken = "hardwareharness-direct-e2e-token";

test.describe.serial("manual control and Agent hardware calls", () => {
  let fixture: HardwareMcpFixture;
  let application: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let projectRoot: string;

  test.beforeAll(async () => {
    fixture = await startHardwareMcpFixture();
    userDataDir = await mkdtemp(resolve(tmpdir(), "hardwareharness-manual-control-"));
    projectRoot = join(userDataDir, "manual-control-project");
    await mkdir(projectRoot);
    ({ application, page } = await launch(userDataDir));
  });

  test.afterAll(async () => {
    await application?.close().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
    if (userDataDir?.startsWith(tmpdir())) await rm(userDataDir, { recursive: true, force: true });
  });

  test("invokes a real fixture hardware tool from a generated form", async () => {
    await page.evaluate(async ({ projectRoot, fixtureUrl, token }) => {
      await window.hardwareharness.projects.initializeFolder(projectRoot);
      await window.hardwareharness.devices.saveComputer({ id: "LOCAL_FIXTURE", label: "Local fixture", address: "127.0.0.1", ssh: { port: 22, username: "fixture" } });
      await window.hardwareharness.devices.saveServer({
        serverId: "E2E_MCP", computerId: "LOCAL_FIXTURE", label: "E2E fixture MCP", hardwareId: "E2E_CARD", url: fixtureUrl, enabled: true,
        lifecycle: { statusCommand: "fixture-status", startCommand: "fixture-start", stopCommand: "fixture-stop", logPath: "fixture-logs" }
      }, { mcpToken: token });
      await window.hardwareharness.devices.saveHardware({
        formatVersion: 2, hardwareId: "E2E_CARD", label: "E2E fixture card", kind: "managed", serverId: "E2E_MCP", computerId: "LOCAL_FIXTURE",
        ports: [{ portId: "AO", name: "AO", pins: [{ pinId: "0", position: 1, label: "AO0" }] }]
      });
      await window.hardwareharness.devices.refreshServer("E2E_MCP");
      await window.hardwareharness.wiring.update({ nodes: [{ hardwareId: "E2E_CARD", x: 20, y: 20, portPositions: {} }], connections: [] });
      await window.hardwareharness.projects.save();
      await window.hardwareharness.projects.leave();
    }, { projectRoot, fixtureUrl: fixture.url, token: fixture.token });
    await reloadAfterLeave(page);
    await page.getByText("manual-control-project", { exact: true }).first().click();
    await page.getByRole("tab", { name: "设备管理" }).click();

    await expect(page.getByRole("heading", { name: "设备管理" })).toBeVisible();
    await page.getByRole("treeitem", { name: /E2E fixture card/ }).click();
    await expect(page.getByRole("button", { name: "占用硬件" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "释放硬件" })).toHaveCount(0);
    await page.getByRole("button", { name: /write_voltage/ }).click();
    await expect(page.getByText("Hardware ID", { exact: true })).toHaveCount(0);
    await page.getByLabel("Voltage").fill("4.2");
    await page.getByLabel("Mode").selectOption("pulse");
    await page.getByRole("button", { name: "执行一次" }).click();
    await expect(page.getByText("调用成功", { exact: true })).toBeVisible();
    const resultPre = page.getByText("调用成功", { exact: true }).locator("xpath=ancestor::section//pre");
    await expect(resultPre).toContainText('"hardwareId": "E2E_CARD"');
    await expect(resultPre).toContainText('"voltage": 4.2');

    const write = fixture.calls.filter((call) => call.name === "write_voltage").at(-1);
    expect(write?.arguments).toMatchObject({ hardwareId: "E2E_CARD", voltage: 4.2, mode: "pulse", options: { enabled: true }, tags: ["smoke"] });
  });

  test("AI calls hardware directly without a manual approval request", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${gatewayToken}` } }
    });
    const client = new Client({ name: "direct-e2e-agent", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.some((tool) => tool.name.includes("occupancy"))).toBe(false);
      // Device tools are listed but callable only after the session enables their hardware.
      const enabled = await client.callTool({ name: "enable_device_tools", arguments: { hardwareId: "E2E_CARD" } });
      expect(enabled.isError, JSON.stringify(enabled.content)).not.toBe(true);
      const result = await client.callTool({ name: "E2E_MCP__write_voltage", arguments: {
        hardwareId: "E2E_CARD", voltage: 1.5, mode: "dc", options: { enabled: true }, tags: ["agent"]
      } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(fixture.calls.at(-1)).toMatchObject({ name: "write_voltage", arguments: { voltage: 1.5 } });
    } finally {
      await transport.close();
    }
    await expect(page.getByRole("dialog", { name: "AI 请求人工占用硬件" })).toHaveCount(0);
  });
});

async function launch(userDataDir: string): Promise<{ application: ElectronApplication; page: Page }> {
  const env = {
    ...process.env,
    HARDWAREHARNESS_USER_DATA_DIR: userDataDir,
    HARDWAREHARNESS_GATEWAY_PORT: String(gatewayPort),
    HARDWAREHARNESS_GATEWAY_TEST_TOKEN: gatewayToken,
    HARDWAREHARNESS_AGENT_INTEGRATION_TEST_MODE: "1"
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: [desktopDir], cwd: desktopDir, env, timeout: 90_000 });
  const page = await rendererReady(await application.firstWindow({ timeout: 90_000 }));
  page.setDefaultTimeout(30_000);
  return { application, page };
}
