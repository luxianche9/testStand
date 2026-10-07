import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { reloadAfterLeave, rendererReady } from "./renderer.js";

const desktopDir = resolve(import.meta.dirname, "..");
const artifacts = resolve(desktopDir, "../../output/playwright/signal-view");

test.describe.serial("signal view and pin list", () => {
  let app: ElectronApplication;
  let page: Page;
  let userData: string;
  const errors: string[] = [];
  test.beforeAll(async () => {
    userData = await mkdtemp(join(tmpdir(), "teststand-signal-view-"));
    const projectRoot = join(userData, "signal-fixture");
    await mkdir(projectRoot);
    await mkdir(artifacts, { recursive: true });
    const env = { ...process.env, TESTSTAND_USER_DATA_DIR: userData,
      TESTSTAND_GATEWAY_PORT: "0", TESTSTAND_AGENT_INTEGRATION_TEST_MODE: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [desktopDir], cwd: desktopDir, env, timeout: 90_000 });
    page = await rendererReady(await app.firstWindow());
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setMinimumSize(0, 0);
      BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800);
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
    await page.evaluate(async (root) => {
      await window.teststand.projects.initializeFolder({ rootPath: root });
      await window.teststand.devices.saveHardware({ input: {
        formatVersion: 2, hardwareId: "DUT", label: "被测板", kind: "passive",
        ports: [{ portId: "J1", name: "J1", pins: [
          { pinId: "1", position: 1, label: "EN" }, { pinId: "2", position: 2, label: "GND" }
        ] }],
        signals: [
          { signalId: "enable", label: "电源使能", type: "bits", direction: "input" },
          { signalId: "vout", label: "输出电压", type: "scalar", direction: "output", unit: "V" }
        ]
      } });
      await window.teststand.devices.saveHardware({ input: {
        formatVersion: 2, hardwareId: "FIX", label: "转接箱", kind: "passive",
        ports: [{ portId: "P1", name: "P1", pins: [{ pinId: "1", position: 1, label: "" }] }], signals: []
      } });
      await window.teststand.wiring.updateDocument({ wiring: { connections: [{
        connectionId: "C1", portA: "DUT.J1", portB: "FIX.P1", pins: [{ a: "1", b: "1" }],
        confirmedAt: "2026-10-07T00:00:00.000Z", confirmedBy: "user"
      }] } });
      await window.teststand.signals.updateDocument({ signals: {
        nodes: [
          { nodeId: "dut", kind: "hardware", hardwareId: "DUT", x: 40, y: 40 },
          { nodeId: "scope", kind: "widget", widget: "scope", label: "", config: {}, x: 380, y: 20, width: 420, height: 240 },
          { nodeId: "sw", kind: "widget", widget: "switch", label: "", config: {}, x: 380, y: 300, width: 220, height: 110 }
        ],
        links: [
          { linkId: "l1", from: { nodeId: "dut", handle: "vout" }, to: { nodeId: "scope", handle: "in" } },
          { linkId: "l2", from: { nodeId: "sw", handle: "out" }, to: { nodeId: "dut", handle: "enable" } }
        ]
      } });
      await window.teststand.projects.saveProject();
      await window.teststand.projects.leaveProject();
    }, projectRoot);
    await reloadAfterLeave(page);
    await page.getByText("signal-fixture", { exact: true }).first().click();
  });
  test.afterAll(async () => {
    await app?.close().catch(() => undefined);
    if (userData && dirname(userData) === resolve(tmpdir())) await rm(userData, { recursive: true, force: true });
  });

  test("opens the bench on the signal view with hardware, widgets and links", async () => {
    const canvas = page.getByRole("region", { name: "信号视图" });
    await expect(canvas.locator('.react-flow__node[data-id="dut"]')).toContainText("电源使能");
    await expect(canvas.locator('.react-flow__node[data-id="scope"]')).toContainText("示波器");
    await expect(canvas.locator(".react-flow__edge")).toHaveCount(2);
    // A passive signal not yet carried by a device stream says so instead of showing data.
    await expect(canvas.locator('.react-flow__node[data-id="sw"]')).toContainText("信号还没有连到设备的流");
    await page.screenshot({ path: join(artifacts, "signal-view.png") });
  });

  test("adds a widget from the palette and keeps it after a save", async () => {
    await page.getByRole("button", { name: "添加数值" }).click();
    await expect(page.locator('.react-flow__node-widget')).toHaveCount(3);
    const signals = await page.evaluate(async () => (await window.teststand.projects.document())?.file.signals);
    expect(signals?.nodes.filter((node) => node.kind === "widget").map((node) => node.kind === "widget" && node.widget))
      .toEqual(["scope", "switch", "value"]);
  });

  test("shows a run started in the plan editor on the signal view from its first step", async () => {
    await page.evaluate(async () => {
      const created = await window.teststand.testing.createPlan({ input: { requestId: crypto.randomUUID(), name: "信号视图运行" } });
      await window.teststand.testing.applyPlanOperations({ input: {
        planId: created.plan.id, baseRevision: created.plan.revision, requestId: crypto.randomUUID(),
        operations: [
          { type: "insert_step", region: "test", step: { id: "first", type: "PublishResult", name: "第一步", value: "ok" } },
          { type: "insert_step", region: "test", step: { id: "wait", type: "Delay", name: "等待", durationMs: 1_500 } }
        ]
      } });
    });
    await page.getByRole("tab", { name: "测试编排", exact: true }).click();
    await page.getByRole("button", { name: /信号视图运行/ }).first().click();
    await page.getByRole("button", { name: "运行", exact: true }).click();
    // The bench is shown at once, with the run docked under the canvas.
    await expect(page.getByRole("region", { name: "信号视图" })).toBeVisible();
    const dock = page.getByRole("region", { name: "运行面板" });
    await expect(dock).toContainText("信号视图运行");
    await expect(page.getByRole("button", { name: /正在运行 信号视图运行/ })).toBeVisible();
    await expect(dock.getByText("第一步").first()).toBeVisible();
    await page.screenshot({ path: join(artifacts, "run-docked.png") });
    // Finished, the run stays on the canvas as a replay until the operator returns to live data.
    await expect(dock.getByRole("button", { name: "返回实时" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /正在运行/ })).toHaveCount(0);
    await dock.getByRole("button", { name: "返回实时" }).click();
    await expect(dock).toHaveCount(0);
  });

  test("shows the physical wiring as a pin list", async () => {
    await page.getByRole("button", { name: "针脚列表", exact: true }).click();
    const list = page.getByRole("region", { name: "针脚列表" });
    await expect(list).toContainText("被测板");
    await expect(list).toContainText("1 (EN)");
    await page.screenshot({ path: join(artifacts, "pin-list.png") });
    expect(errors).toEqual([]);
  });
});
