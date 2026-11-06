import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  _electron as electron, expect, test, type ElectronApplication, type Locator, type Page
} from "@playwright/test";
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
      await window.teststand.monitor.update({ input: { operations: [{ op: "addPanel", panel: {
        id: "scope", type: "scope", title: "示波器",
        sources: [{ hardwareId, streamId: "relay" }, { hardwareId, streamId: "di" }]
      } }] } });
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
    await expect(panel.locator("[data-canvas-item='scope']")).toContainText("示波器");
    const channels = panel.getByRole("complementary", { name: "通道" });
    // The signal list starts folded: the legend above the trace names the signals.
    const scope = panel.getByRole("toolbar", { name: "示波器控制" });
    await expect(channels).toHaveCount(0);
    await expect(scope.getByLabel("显示的信号")).toContainText("relay");
    const tools = page.getByRole("toolbar", { name: "台架工具栏" }).getByRole("group", { name: "运行监控工具" });
    await expect(tools).toContainText("实时数据");
    // One horizontal section for every panel, in the bench's title row: time/div, position, RUN/STOP.
    await expect(tools.getByRole("group", { name: "水平" })).toContainText("1 s/div");
    await tools.getByRole("button", { name: "时基调粗" }).click();
    await expect(tools.getByRole("group", { name: "水平" })).toContainText("2 s/div");
    await expect(tools.getByRole("button", { name: "停止跟随", exact: true })).toBeVisible();
    // Each scope keeps its vertical section; its signal list opens on demand (and stays open).
    await expect(scope.getByRole("group", { name: "垂直" })).toBeVisible();
    await scope.getByRole("button", { name: /^信号/ }).click();
    await expect(channels.getByRole("button", { name: "relay" })).toBeVisible();
    await expect(channels.getByRole("button", { name: "di" })).toBeVisible();
    // The panel only watches: no canvas, no control widgets.
    await expect(panel.locator(".react-flow")).toHaveCount(0);
    await page.screenshot({ path: join(artifacts, "monitor.png") });
  });

  test("expands a device in the devices panel and removes a channel from the scope", async () => {
    await showPanel(page, "设备管理");
    const list = page.getByRole("complementary", { name: "设备列表" });
    await list.getByRole("button", { name: /^继电器卡/ }).click();
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

  test("places the panels the Agent adds, and moves, resizes and removes them in edit mode", async () => {
    const panel = page.getByRole("region", { name: "运行监控" });
    await page.evaluate(async (id) => {
      await window.teststand.monitor.update({ input: { operations: [
        { op: "addPanel", panel: { id: "dio", type: "digital", title: "继电器", sources: [{ hardwareId: id, streamId: "di" }] } },
        { op: "addPanel", panel: { type: "results" } }
      ] } });
    }, hardwareId);
    const relays = panel.locator("[data-canvas-item='dio']");
    await expect(relays).toContainText("继电器");
    await expect(panel.locator("[data-canvas-item='results']")).toContainText("运行测试或打开历史运行后显示判定结果");
    // New panels take the first free spot: none overlaps another.
    const frames = await page.evaluate(async () =>
      (await window.teststand.monitor.get()).panels.map((item) => item.frame!));
    for (const [index, a] of frames.entries()) {
      for (const b of frames.slice(index + 1)) {
        expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
      }
    }
    // 编辑布局: drag a panel by 100 px (5 cells), pull its corner, remove another.
    const tools = page.getByRole("toolbar", { name: "台架工具栏" });
    await tools.getByRole("button", { name: "编辑布局" }).click();
    const before = frames.find((_, index) => index === 1)!;
    const handle = relays.getByLabel("移动 继电器");
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 70, box.y + 40);
    await page.mouse.move(box.x + 120, box.y + 60);
    await page.mouse.up();
    await expect.poll(async () => page.evaluate(async () =>
      (await window.teststand.monitor.get()).panels.find((item) => item.id === "dio")?.frame?.x)).toBe(before.x + 5);
    const grip = relays.getByRole("separator", { name: "调整 继电器 的大小" });
    await grip.scrollIntoViewIfNeeded();
    const corner = (await grip.boundingBox())!;
    await page.mouse.move(corner.x + 4, corner.y + 4);
    await page.mouse.down();
    await page.mouse.move(corner.x + 44, corner.y + 44);
    await page.mouse.up();
    await expect.poll(async () => page.evaluate(async () =>
      (await window.teststand.monitor.get()).panels.find((item) => item.id === "dio")?.frame?.w)).toBe(before.w + 2);
    await expect(page.getByRole("complementary", { name: "属性" }).getByRole("textbox", { name: "面板标题" }))
      .toHaveValue("继电器");
    await panel.getByRole("button", { name: "删除 结果" }).click();
    await expect(panel.locator("[data-canvas-item='results']")).toHaveCount(0);
    await page.screenshot({ path: join(artifacts, "workspace.png") });
    await tools.getByRole("button", { name: "编辑布局" }).click();
    const ids = await page.evaluate(async () =>
      (await window.teststand.monitor.get()).panels.map((item) => item.id));
    expect(ids).toEqual(["scope", "dio"]);
  });

  test("hosts every kind of panel, a control panel, and layouts made from the data", async () => {
    const panel = page.getByRole("region", { name: "运行监控" });
    await page.evaluate(async (id) => {
      const relay = { hardwareId: id, streamId: "relay" };
      await window.teststand.monitor.update({ input: { operations: [
        { op: "addPanel", panel: { id: "vals", type: "values", title: "数值", sources: [relay] } },
        { op: "addPanel", panel: { id: "states", type: "timeline", title: "时间线" } },
        { op: "addPanel", panel: { id: "word", type: "register", title: "状态字", settings: {
          fields: [{ name: "MODE", lsb: 0, width: 2 }] } } },
        { op: "addPanel", panel: { id: "bus", type: "trace", title: "总线", settings: { mode: "fixed" } } },
        { op: "addPanel", panel: { id: "frame", type: "detail", title: "报文详情" } },
        { op: "addPanel", panel: { id: "panel", type: "control", title: "手动控制", settings: { controls: [
          { label: "K0", hardwareId: id, tool: "set_relay", widget: "toggle", param: "closed", fixed: { channel: 0 } }
        ] } } },
        { op: "addPanel", panel: { id: "tree", type: "sources", title: "数据源" } },
        { op: "addPanel", panel: { id: "big", type: "number", sources: [relay] } },
        { op: "addPanel", panel: { id: "lamp", type: "lamp", sources: [relay], settings: { bit: 0 } } },
        { op: "addPanel", panel: { id: "note", type: "label", settings: { text: "继电器卡" } } }
      ] } });
    }, hardwareId);
    for (const id of ["vals", "word", "bus", "frame", "panel", "tree", "big", "lamp", "note"]) {
      await expect(panel.locator(`[data-canvas-item='${id}']`)).toBeVisible();
    }
    await expect(panel.locator("[data-canvas-item='note']")).toContainText("继电器卡");
    // The device has no card: its control waits for the tool, the trace and the detail are empty.
    await expect(panel).toContainText("设备离线或没有工具");
    await expect(panel).toContainText("在总线跟踪里点一帧");
    await expect(panel).toContainText("把串口或总线数据流拖到这里");
    // In edit mode the property panel shows the panel picked.
    const tools = page.getByRole("toolbar", { name: "台架工具栏" });
    await tools.getByRole("button", { name: "编辑布局" }).click();
    await panel.getByLabel("移动 状态字").click();
    const properties = page.getByRole("complementary", { name: "属性" });
    await expect(properties.getByRole("textbox", { name: "面板标题" })).toHaveValue("状态字");
    await expect(properties.getByRole("textbox", { name: "位域名称" })).toHaveValue("MODE");
    await tools.getByRole("button", { name: "编辑布局" }).click();
    await page.screenshot({ path: join(artifacts, "panels.png") });

    // A layout made from the data, each panel in the next free spot.
    await page.getByRole("toolbar", { name: "台架工具栏" }).getByRole("button", { name: "布局", exact: true }).click();
    await page.getByRole("menuitem", { name: "按数据生成布局" }).click();
    await expect.poll(async () => page.evaluate(async () =>
      (await window.teststand.monitor.get()).panels.map((item) => item.type).join(","))).toBe("scope,values");
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

  test("builds the canvas by dragging components and variables onto it", async () => {
    const panel = page.getByRole("region", { name: "运行监控" });
    await page.evaluate(() => window.teststand.monitor.update({ input: { panels: [] } }));
    await expect(panel).toContainText("这是一整页画布");
    const surface = panel.getByTestId("canvas-surface");
    // The components are the activity bar's second panel.
    await showPanel(page, "组件");
    const bar = page.getByRole("region", { name: "组件" });
    // The relay stream (bits) dragged as the devices panel drags it, onto `target`.
    const dragRelay = async (target: Locator) => {
      const data = await page.evaluateHandle((id) => {
        const transfer = new DataTransfer();
        transfer.setData("application/x-teststand-stream", JSON.stringify({ hardwareId: id, streamId: "relay" }));
        transfer.setData("application/x-teststand-stream-type-bits", "bits");
        return transfer;
      }, hardwareId);
      await page.locator("body").dispatchEvent("dragstart", { dataTransfer: data });
      await page.waitForTimeout(150);
      await target.dispatchEvent("dragenter", { dataTransfer: data });
      await target.dispatchEvent("dragover", { dataTransfer: data });
      await page.waitForTimeout(150);
      await target.dispatchEvent("drop", { dataTransfer: data });
      await page.locator("body").dispatchEvent("dragend", { dataTransfer: data });
    };
    const types = async () => page.evaluate(async () =>
      (await window.teststand.monitor.get()).panels.map((item) => `${item.type}:${item.sources.length}`).join(","));
    // A variable dropped on an empty spot becomes a fitting widget: a bit is a lamp.
    await dragRelay(surface);
    await expect.poll(types).toBe("lamp:1");

    // A component dragged in becomes a panel where it is dropped; a click puts one in the first free spot.
    await bar.getByRole("button", { name: "组件 数值表" }).dragTo(surface, { targetPosition: { x: 400, y: 200 } });
    await expect.poll(types).toBe("lamp:1,values:0");
    await bar.getByRole("button", { name: "组件 数字量" }).click();
    await expect.poll(types).toBe("lamp:1,values:0,digital:0");

    // A bits signal goes onto the digital panel, never onto the values table.
    await dragRelay(panel.locator("[data-panel-id^='values']"));
    await page.waitForTimeout(500);
    expect(await types()).toBe("lamp:1,values:0,digital:0");
    await dragRelay(panel.locator("[data-panel-id^='digital']"));
    await expect.poll(types).toBe("lamp:1,values:0,digital:1");

    // A switch is a widget of its own; it asks what device action it calls.
    await bar.getByRole("button", { name: "组件 开关" }).click();
    await expect.poll(types).toBe("lamp:1,values:0,digital:1,switch:0");
    await expect(panel.getByRole("button", { name: "设置它调用的设备动作" })).toBeVisible();
    await page.screenshot({ path: join(artifacts, "drag-built.png") });
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
