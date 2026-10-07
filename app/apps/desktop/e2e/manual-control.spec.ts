import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { reloadAfterLeave, rendererReady, showPanel } from "./renderer.js";

const desktopDir = resolve(import.meta.dirname, "..");
const gatewayPort = 18086;
const gatewayToken = "teststand-direct-e2e-token";
const hardwareId = "E2E_RELAY_CARD";

test.describe.serial("manual control and Agent hardware calls", () => {
  let application: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let projectRoot: string;

  test.beforeAll(async () => {
    userDataDir = await mkdtemp(resolve(tmpdir(), "teststand-manual-control-"));
    projectRoot = join(userDataDir, "manual-control-project");
    await mkdir(projectRoot);
    ({ application, page } = await launch(userDataDir));
  });

  test.afterAll(async () => {
    await application?.close().catch(() => undefined);
    if (userDataDir?.startsWith(tmpdir())) await rm(userDataDir, { recursive: true, force: true });
  });

  test("controls the real PCI-1762 from its canvas card", async () => {
    const status = await page.evaluate(async ({ projectRoot, hardwareId }) => {
      await window.teststand.projects.initializeFolder({ rootPath: projectRoot });
      await window.teststand.devices.saveDevice({ input: {
        deviceId: "E2E_RELAY", label: "PCI-1762 e2e", hardwareId, type: "pci1762",
        settings: {}, enabled: true
      } });
      const status = await window.teststand.devices.refreshDevice({ deviceId: "E2E_RELAY" });
      await window.teststand.signals.updateDocument({ signals: {
        nodes: [{ nodeId: "card", kind: "hardware", hardwareId, x: 20, y: 20 }], links: [] } });
      await window.teststand.projects.saveProject();
      await window.teststand.projects.leaveProject();
      return status;
    }, { projectRoot, hardwareId });
    expect(status.transport.state, status.transport.message).toBe("online");
    await reloadAfterLeave(page);
    await page.getByText("manual-control-project", { exact: true }).first().click();
    await showPanel(page, "设备");

    // Clicking the device in the list shows its information; the card on the canvas controls it.
    await page.getByRole("complementary", { name: "设备列表" }).getByRole("button", { name: /PCI-1762 e2e/ }).click();
    const info = page.getByRole("dialog", { name: "PCI-1762 e2e" });
    await expect(info.getByText("CN1", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "控制 PCI-1762 e2e" }).click();
    const menu = page.getByRole("menu", { name: "PCI-1762 e2e 的控制动作" });
    await expect(menu.getByRole("menuitem")).toHaveText([/set_relay/, /set_bank/, /read_bit/, /safe_state/]);
    await menu.getByRole("menuitem", { name: /set_relay/ }).click();
    const action = page.getByRole("dialog", { name: "PCI-1762 e2e · set_relay" });
    await action.getByLabel(/Channel/).fill("2");
    await action.getByLabel(/Closed/).check();
    await action.getByRole("button", { name: "确认执行" }).click();
    await expect(action.getByText("调用成功", { exact: true })).toBeVisible();
    await expect(action.locator("pre")).toContainText('"closed": true');

    const readback = await page.evaluate(async (hardwareId) => (await window.teststand.manual.invokeTool({ raw: {
      hardwareId, toolName: "E2E_RELAY__pci1762_read_bit", arguments: { channel: 2, kind: "RELAY" }
    } })).output, hardwareId);
    expect(JSON.stringify(readback)).toContain('"value":true');
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
      const enabled = await client.callTool({ name: "enable_device_tools", arguments: { hardwareId } });
      expect(enabled.isError, JSON.stringify(enabled.content)).not.toBe(true);
      const result = await client.callTool({ name: "E2E_RELAY__pci1762_set_relay", arguments: { channel: 5, closed: true } });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const readback = await client.callTool({ name: "E2E_RELAY__pci1762_read_bit", arguments: { channel: 5, kind: "RELAY" } });
      expect(readback.isError, JSON.stringify(readback.content)).not.toBe(true);
      expect(JSON.stringify(readback.structuredContent ?? readback.content)).toMatch(/\\?"value\\?":\s*true/);
    } finally {
      await transport.close();
    }
    await expect(page.getByRole("dialog", { name: "AI 请求人工占用硬件" })).toHaveCount(0);
  });
});

async function launch(userDataDir: string): Promise<{ application: ElectronApplication; page: Page }> {
  const env = {
    ...process.env,
    TESTSTAND_USER_DATA_DIR: userDataDir,
    TESTSTAND_GATEWAY_PORT: String(gatewayPort),
    TESTSTAND_GATEWAY_TEST_TOKEN: gatewayToken,
    TESTSTAND_AGENT_INTEGRATION_TEST_MODE: "1"
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: [desktopDir], cwd: desktopDir, env, timeout: 90_000 });
  const page = await rendererReady(await application.firstWindow({ timeout: 90_000 }));
  page.setDefaultTimeout(30_000);
  return { application, page };
}
