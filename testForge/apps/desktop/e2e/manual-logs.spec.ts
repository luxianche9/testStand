import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHardwareMcpFixture, type HardwareMcpFixture } from "./fixtures/hardware-mcp.js";

const desktopDir = resolve(import.meta.dirname, "..");
const gatewayPort = 18086;
const gatewayToken = "testforge-occupancy-e2e-token";

test.describe.serial("manual control and persisted Run logs", () => {
  let fixture: HardwareMcpFixture;
  let application: ElectronApplication;
  let page: Page;
  let userDataDir: string;
  let projectRoot: string;

  test.beforeAll(async () => {
    fixture = await startHardwareMcpFixture();
    userDataDir = await mkdtemp(resolve(tmpdir(), "testforge-manual-logs-"));
    projectRoot = join(userDataDir, "manual-logs-project");
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
      await window.testforge.projects.initializeFolder(projectRoot);
      await window.testforge.devices.saveComputer({ id: "LOCAL_FIXTURE", label: "Local fixture", address: "127.0.0.1", ssh: { port: 22, username: "fixture" } });
      await window.testforge.devices.saveServer({
        serverId: "E2E_MCP", computerId: "LOCAL_FIXTURE", label: "E2E fixture MCP", hardwareId: "E2E_CARD", url: fixtureUrl, enabled: true,
        lifecycle: { statusCommand: "fixture-status", startCommand: "fixture-start", stopCommand: "fixture-stop", logPath: "fixture-logs" }
      }, { mcpToken: token });
      await window.testforge.devices.saveHardware({
        formatVersion: 2, hardwareId: "E2E_CARD", label: "E2E fixture card", kind: "managed", serverId: "E2E_MCP", computerId: "LOCAL_FIXTURE",
        ports: [{ portId: "AO", name: "AO", pins: [{ pinId: "0", position: 1, label: "AO0" }] }]
      });
      await window.testforge.devices.refreshServer("E2E_MCP");
      await window.testforge.wiring.update({ nodes: [{ hardwareId: "E2E_CARD", x: 20, y: 20, showImage: true, portPositions: {} }], connections: [] });
      await window.testforge.projects.save();
      await window.testforge.projects.leave();
    }, { projectRoot, fixtureUrl: fixture.url, token: fixture.token });
    await page.reload();
    await page.getByText("manual-logs-project", { exact: true }).first().click();
    await page.getByRole("tab", { name: "设备管理" }).click();

    await expect(page.getByRole("heading", { name: "设备管理" })).toBeVisible();
    await page.getByRole("treeitem", { name: /E2E fixture MCP/ }).click();
    await expect(page.getByRole("button", { name: "占用硬件" })).toBeEnabled();
    await page.getByRole("button", { name: "占用硬件" }).click();
    await expect(page.getByRole("button", { name: "释放硬件" })).toBeVisible();
    await page.getByRole("button", { name: /write_voltage/ }).click();
    await expect(page.locator(".schema-fields").getByText("Hardware ID", { exact: true })).toHaveCount(0);
    await page.getByLabel("Voltage").fill("4.2");
    await page.getByLabel("Mode").selectOption("pulse");
    await page.getByRole("button", { name: "执行一次" }).click();
    await expect(page.getByText("调用成功", { exact: true })).toBeVisible();
    await expect(page.locator(".manual-result pre")).toContainText('"hardwareId": "E2E_CARD"');
    await expect(page.locator(".manual-result pre")).toContainText('"voltage": 4.2');

    const write = fixture.calls.filter((call) => call.name === "write_voltage").at(-1);
    expect(write?.arguments).toMatchObject({ hardwareId: "E2E_CARD", voltage: 4.2, mode: "pulse", options: { enabled: true }, tags: ["smoke"] });
  });

  test("persists an orchestration Run across restart, filters, exports and deletes it", async () => {
    const runId = await page.evaluate(async () => {
      const task = {
        formatVersion: 2 as const, taskId: "E2E_TASK", name: "Persisted fixture Run", inputs: [], variables: [], setup: [], cleanup: [],
        steps: [{
          stepId: "WRITE", label: "Write fixture voltage", enabled: true, type: "tool" as const,
          toolName: "E2E_MCP__write_voltage", hardwareId: "E2E_CARD",
          arguments: {
            voltage: { kind: "literal" as const, value: 2.5 },
            mode: { kind: "literal" as const, value: "dc" },
            options: { kind: "literal" as const, value: { enabled: true } },
            tags: { kind: "literal" as const, value: ["run"] }
          },
          outputBindings: [], timeoutMs: 30_000, idempotent: false, retry: { maxAttempts: 1, delayMs: 0, backoff: "fixed", retryOn: ["unavailable"] }
        }]
      };
      await window.testforge.orchestration.updateTask(task);
      const started = await window.testforge.orchestration.startRun();
      return started.run.runId;
    });
    await expect.poll(async () => page.evaluate(async (id) => (await window.testforge.orchestration.getRun(id)).run.status, runId)).toBe("passed");

    await application.close();
    ({ application, page } = await launch(userDataDir));
    await page.getByText("manual-logs-project", { exact: true }).first().click();
    await page.getByRole("tab", { name: "运行日志" }).click();
    await expect(page.getByRole("heading", { name: "运行日志" })).toBeVisible();
    await page.getByLabel("搜索运行日志").fill("Persisted fixture");
    const runRow = page.getByRole("row", { name: /Persisted fixture Run passed/ });
    await expect(runRow).toBeVisible();
    await runRow.click();
    await expect(page.getByRole("complementary", { name: "运行检查器" })).toContainText("Write fixture voltage");
    await page.getByRole("button", { name: "打开完整详情" }).click();
    await expect(page.getByRole("dialog", { name: "运行详情" }).getByText("run.passed", { exact: true })).toBeVisible();
    await page.getByRole("dialog", { name: "运行详情" }).getByRole("button", { name: "关闭" }).click();

    const exported = await page.evaluate((id) => window.testforge.orchestration.exportRun(id), runId);
    expect(exported).toMatchObject({ formatVersion: 1, run: { runId, taskName: "Persisted fixture Run", status: "passed" }, nodeRuns: [{ nodeLabel: "Write fixture voltage", status: "passed" }] });

    await page.getByRole("button", { name: "删除", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "删除运行日志" });
    await dialog.getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByText("没有符合条件的运行记录。")).toBeVisible();
    expect(await page.evaluate((id) => window.testforge.orchestration.getRun(id).then(() => false, () => true), runId)).toBe(true);
  });

  test("delivers an AI occupancy request to the global mailbox for one human click", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${gatewayToken}` } }
    });
    const client = new Client({ name: "occupancy-e2e-agent", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      await client.callTool({ name: "request_hardware_occupancy", arguments: { hardwareIds: ["E2E_CARD"], reason: "AI E2E Run" } });
    } finally {
      await transport.close();
    }

    const prompt = page.getByRole("dialog", { name: "AI 请求人工占用硬件" });
    await expect(prompt).toContainText("E2E_CARD");
    await prompt.getByRole("button", { name: "占用全部" }).click();
    await expect(prompt).toBeHidden();

    await page.getByRole("button", { name: "信箱" }).click();
    const mailbox = page.getByRole("dialog", { name: "信箱" });
    await expect(mailbox).toContainText("E2E fixture card");
    await expect(mailbox).toContainText("confirmed");
  });
});

async function launch(userDataDir: string): Promise<{ application: ElectronApplication; page: Page }> {
  const env = {
    ...process.env,
    TESTFORGE_USER_DATA_DIR: userDataDir,
    TESTFORGE_GATEWAY_PORT: String(gatewayPort),
    TESTFORGE_GATEWAY_TEST_TOKEN: gatewayToken,
    TESTFORGE_AGENT_INTEGRATION_TEST_MODE: "1"
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: [desktopDir], cwd: desktopDir, env, timeout: 90_000 });
  const page = await application.firstWindow({ timeout: 90_000 });
  page.setDefaultTimeout(30_000);
  return { application, page };
}
