import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { reloadAfterLeave, rendererReady, showPanel } from "./renderer.js";

const desktopDir = resolve(import.meta.dirname, "..");
const artifacts = resolve(desktopDir, "../../output/playwright/monitor-panel");
const hardwareId = "MON_RELAY_CARD";

test.describe.serial("monitor panel and pin list", () => {
  let app: ElectronApplication;
  let page: Page;
  let userData: string;
  const errors: string[] = [];
  test.beforeAll(async () => {
    userData = await mkdtemp(join(tmpdir(), "teststand-monitor-"));
    const projectRoot = join(userData, "monitor-fixture");
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
    await page.evaluate(async ({ root, hardwareId }) => {
      await window.teststand.projects.initializeFolder({ rootPath: root });
      await window.teststand.devices.saveHardware({ input: {
        formatVersion: 2, hardwareId: "DUT", label: "被测板", kind: "passive",
        ports: [{ portId: "J1", name: "J1", pins: [
          { pinId: "1", position: 1, label: "EN" }, { pinId: "2", position: 2, label: "GND" }
        ] }]
      } });
      await window.teststand.devices.saveHardware({ input: {
        formatVersion: 2, hardwareId: "FIX", label: "转接箱", kind: "passive",
        ports: [{ portId: "P1", name: "P1", pins: [{ pinId: "1", position: 1, label: "" }] }]
      } });
      // A device without its card: registered, its streams not known until it connects.
      await window.teststand.devices.saveDevice({ input: {
        deviceId: "MON_RELAY", label: "继电器卡", hardwareId, type: "pci1762", settings: {}, enabled: true
      } });
      await window.teststand.wiring.updateDocument({ wiring: { nodes: [], connections: [{
        connectionId: "C1", portA: "DUT.J1", portB: "FIX.P1", pins: [{ a: "1", b: "1" }],
        confirmedAt: "2026-10-07T00:00:00.000Z", confirmedBy: "user"
      }] } });
      await window.teststand.monitor.update({ input: { add: [
        { hardwareId, streamId: "relay" }, { hardwareId, streamId: "di" }
      ] } });
      await window.teststand.projects.saveProject();
      await window.teststand.projects.leaveProject();
    }, { root: projectRoot, hardwareId });
    await reloadAfterLeave(page);
    await page.getByText("monitor-fixture", { exact: true }).first().click();
  });
  test.afterAll(async () => {
    await app?.close().catch(() => undefined);
    if (userData && dirname(userData) === resolve(tmpdir())) await rm(userData, { recursive: true, force: true });
  });

  test("opens the bench on the monitor workspace with its channels on the scope", async () => {
    const panel = page.getByRole("region", { name: "运行监控" });
    await expect(panel.locator(".dv-tab", { hasText: "示波器" })).toBeVisible();
    const channels = panel.getByRole("complementary", { name: "通道" });
    await expect(channels.getByRole("button", { name: "relay" })).toBeVisible();
    await expect(channels.getByRole("button", { name: "di" })).toBeVisible();
    const tools = page.getByRole("toolbar", { name: "台架工具栏" }).getByRole("group", { name: "运行监控工具" });
    await expect(tools).toContainText("实时数据");
    // One horizontal section for every panel, in the bench's title row: time/div, position, RUN/STOP.
    await expect(tools.getByRole("group", { name: "水平" })).toContainText("1 s/div");
    await tools.getByRole("button", { name: "时基调粗" }).click();
    await expect(tools.getByRole("group", { name: "水平" })).toContainText("2 s/div");
    await expect(tools.getByRole("button", { name: "停止跟随", exact: true })).toBeVisible();
    // Each scope keeps its vertical section and a foldable signal list.
    const scope = panel.getByRole("toolbar", { name: "示波器控制" });
    await expect(scope.getByRole("group", { name: "垂直" })).toBeVisible();
    await scope.getByRole("button", { name: /^信号/ }).click();
    await expect(channels).toHaveCount(0);
    await expect(scope.getByLabel("显示的信号")).toContainText("relay");
    await scope.getByRole("button", { name: /^信号/ }).click();
    await expect(channels.getByRole("button", { name: "relay" })).toBeVisible();
    // The panel only watches: no canvas, no control widgets.
    await expect(panel.locator(".react-flow")).toHaveCount(0);
    await page.screenshot({ path: join(artifacts, "monitor.png") });
  });

  test("expands a device in the devices panel and removes a channel from the scope", async () => {
    await showPanel(page, "设备管理");
    const list = page.getByRole("complementary", { name: "设备列表" });
    await list.getByRole("button", { name: "展开 继电器卡 的数据流" }).click();
    // Without its card the device has not declared its streams yet.
    await expect(list).toContainText("设备连接后显示它声明的数据流");
    await expect(list.getByRole("button", { name: "控制 继电器卡" })).toBeVisible();
    const panel = page.getByRole("region", { name: "运行监控" });
    const channels = panel.getByRole("complementary", { name: "通道" });
    await channels.getByRole("button", { name: "di" }).hover();
    await channels.getByRole("button", { name: "从运行监控移除 di" }).click();
    await expect(channels.getByRole("button", { name: "di" })).toHaveCount(0);
    const monitor = await page.evaluate(async () => (await window.teststand.projects.document())?.file.monitor);
    expect(monitor?.panels.map((item) => [item.type, item.sources])).toEqual([
      ["scope", [{ hardwareId, streamId: "relay" }]]
    ]);
  });

  test("docks panels the Agent adds, and removes a panel closed from its tab", async () => {
    const panel = page.getByRole("region", { name: "运行监控" });
    await page.evaluate(async (id) => {
      await window.teststand.monitor.update({ input: { operations: [
        { op: "addPanel", panel: { id: "dio", type: "digital", title: "继电器", sources: [{ hardwareId: id, streamId: "di" }] },
          placement: { referenceId: "scope", direction: "right" } },
        { op: "addPanel", panel: { type: "results" }, placement: { referenceId: "dio", direction: "within" } }
      ] } });
    }, hardwareId);
    await expect(panel.locator(".dv-tab", { hasText: "继电器" })).toBeVisible();
    const results = panel.locator(".dv-tab", { hasText: "结果" });
    await expect(results).toBeVisible();
    await results.click();
    await expect(panel).toContainText("运行测试或打开历史运行后显示判定结果");
    await results.hover();
    await results.locator(".dv-default-tab-action").click();
    await expect(results).toHaveCount(0);
    const ids = await page.evaluate(async () =>
      (await window.teststand.monitor.get()).panels.map((item) => item.id));
    expect(ids).toEqual(["scope", "dio"]);
    // The arrangement is the project's: saved with it, back when it is opened again.
    await expect.poll(async () => page.evaluate(async () =>
      Boolean((await window.teststand.monitor.get()).layout))).toBe(true);
    await page.screenshot({ path: join(artifacts, "workspace.png") });
  });

  test("hosts every kind of panel, a control panel, and layouts made from the data", async () => {
    const panel = page.getByRole("region", { name: "运行监控" });
    await page.evaluate(async (id) => {
      const relay = { hardwareId: id, streamId: "relay" };
      await window.teststand.monitor.update({ input: { operations: [
        { op: "addPanel", panel: { id: "vals", type: "values", title: "数值", sources: [relay] } },
        { op: "addPanel", panel: { id: "states", type: "timeline", title: "时间线" },
          placement: { referenceId: "vals", direction: "within" } },
        { op: "addPanel", panel: { id: "word", type: "register", title: "状态字", settings: {
          fields: [{ name: "MODE", lsb: 0, width: 2 }] } }, placement: { referenceId: "vals", direction: "below" } },
        { op: "addPanel", panel: { id: "bus", type: "trace", title: "总线", settings: { mode: "fixed" } } },
        { op: "addPanel", panel: { id: "frame", type: "detail", title: "报文详情" },
          placement: { referenceId: "bus", direction: "below" } },
        { op: "addPanel", panel: { id: "panel", type: "control", title: "手动控制", settings: { controls: [
          { label: "K0", hardwareId: id, tool: "set_relay", widget: "toggle", param: "closed", fixed: { channel: 0 } }
        ] } } },
        { op: "addPanel", panel: { id: "tree", type: "sources", title: "数据源" },
          placement: { referenceId: "scope", direction: "left" } },
        { op: "addPanel", panel: { id: "props", type: "inspector", title: "属性" },
          placement: { referenceId: "panel", direction: "below" } }
      ] } });
    }, hardwareId);
    for (const title of ["数值", "状态字", "总线", "报文详情", "手动控制", "数据源", "属性"]) {
      await expect(panel.locator(".dv-tab", { hasText: title }).first()).toBeVisible();
    }
    // The device has no card: its control waits for the tool, the trace and the detail are empty.
    await expect(panel).toContainText("设备离线或没有工具");
    await expect(panel).toContainText("在总线跟踪里点一帧");
    await expect(panel).toContainText("把串口或总线数据流拖到这里");
    // The property panel shows the panel last focused.
    await panel.locator("[data-panel-id=\"word\"]").click({ force: true });
    await expect(panel.getByRole("textbox", { name: "面板标题" })).toHaveValue("状态字");
    await expect(panel.getByRole("textbox", { name: "位域名称" })).toHaveValue("MODE");
    await page.screenshot({ path: join(artifacts, "panels.png") });

    // A layout made from the data: the tree on the left, the property panel on the right.
    await page.getByRole("toolbar", { name: "台架工具栏" }).getByRole("button", { name: "布局" }).click();
    await page.getByRole("menuitem", { name: "按数据生成布局" }).click();
    await expect.poll(async () => page.evaluate(async () =>
      (await window.teststand.monitor.get()).panels.map((item) => item.type).join(","))).toBe("sources,scope,values,inspector");
    await expect(panel.locator(".dv-tab", { hasText: "数据源" })).toBeVisible();
  });

  test("pops a panel out into a window of its own that follows the theme", async () => {
    const panel = page.getByRole("region", { name: "运行监控" });
    const before = app.windows().length;
    const opened = app.waitForEvent("window");
    await panel.getByRole("button", { name: "弹出到独立窗口" }).first().click();
    const popout = await opened;
    expect(app.windows().length).toBe(before + 1);
    await expect.poll(async () => popout.evaluate(() => document.querySelectorAll(".dv-groupview").length))
      .toBeGreaterThan(0);
    const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? "");
    expect(await popout.evaluate(() => document.documentElement.dataset.theme ?? "")).toBe(theme);
    await popout.screenshot({ path: join(artifacts, "popout.png") });
    // The window opens nothing and goes nowhere by itself.
    expect(await popout.evaluate(() => window.open("https://example.com"))).toBeNull();
    await popout.close();
    await expect.poll(() => app.windows().length).toBe(before);
  });

  test("shows a run started from the test panel with its event timeline from the first step", async () => {
    await page.evaluate(async () => {
      const flow = await window.teststand.testing.loadPlan({ planId: "flow" });
      await window.teststand.testing.applyPlanOperations({ input: {
        planId: flow.id, baseRevision: flow.revision, requestId: crypto.randomUUID(),
        operations: [
          { type: "set_plan_fields", patch: { name: "运行监控运行" } },
          { type: "insert_step", region: "test", step: { id: "first", type: "PublishResult", name: "第一步", value: "ok" } },
          { type: "insert_step", region: "test", step: { id: "wait", type: "Delay", name: "等待", durationMs: 1_500 } }
        ]
      } });
    });
    await showPanel(page, "测试编排");
    await page.getByRole("toolbar", { name: "测试流程操作" }).getByRole("button", { name: "运行", exact: true }).click();
    const panel = page.getByRole("region", { name: "运行监控" });
    await expect(panel).toContainText("运行监控运行");
    // The event timeline: regions, steps, verdicts and calls on the run's time axis.
    const overview = panel.getByRole("region", { name: "运行概览" });
    await expect(overview).toBeVisible();
    await expect(overview.getByText("第一步").first()).toBeVisible();
    await page.screenshot({ path: join(artifacts, "run.png") });
    // Finished, the run stays on the panel as a replay until the operator returns to live data.
    await expect(panel.getByRole("button", { name: "返回实时" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("toolbar", { name: "台架工具栏" })).toContainText("历史回放");
    await panel.getByRole("button", { name: "返回实时" }).click();
    await expect(overview).toHaveCount(0);
  });

  test("shows the physical wiring as a pin list", async () => {
    await page.getByRole("group", { name: "台架视图" }).getByRole("button", { name: "工位接线", exact: true }).click();
    const list = page.getByRole("region", { name: "针脚列表" });
    await expect(list).toContainText("被测板");
    const row = page.getByRole("toolbar", { name: "台架工具栏" });
    await expect(row.getByRole("group", { name: "针脚列表工具" }).getByRole("button", { name: "新建接线" })).toBeVisible();
    await expect(row.getByRole("group", { name: "运行监控工具" })).toBeHidden();
    await expect(list).toContainText("1 (EN)");
    await page.screenshot({ path: join(artifacts, "pin-list.png") });

    // 端口连线 is the other half of 工位接线: the same cables, on a canvas with nothing placed yet.
    await page.getByRole("group", { name: "接线视图" }).getByRole("button", { name: "端口连线", exact: true }).click();
    await expect(page.getByText("把设备从左侧拖到画布")).toBeVisible();
    await expect(row.getByRole("group", { name: "端口连线工具" })).toContainText("画布设备");
    expect(errors).toEqual([]);
  });
});
