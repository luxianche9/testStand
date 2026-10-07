import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { reloadAfterLeave, rendererReady, showPanel } from "./renderer.js";

const desktopDir = resolve(import.meta.dirname, "..");
const artifacts = resolve(desktopDir, "../../output/playwright/wiring-single-step");
/** One row group per cable in the pin list. */
const cables = (page: Page) => page.getByRole("table", { name: "针脚连接" }).getByRole("rowgroup");

test.describe.serial("single-step wiring tasks", () => {
  let app: ElectronApplication;
  let page: Page;
  let userData: string;
  const errors: string[] = [];
  test.beforeAll(async () => {
    userData = await mkdtemp(join(tmpdir(), "teststand-wiring-inbox-"));
    const projectRoot = join(userData, "wiring-fixture");
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
      for (const hardwareId of ["DUT_A", "DUT_B"]) {
        await window.teststand.devices.saveHardware({ input: {
          formatVersion: 2, hardwareId, label: hardwareId, kind: "passive",
          ports: [{ portId: "J1", name: "串口", pins: [
            { pinId: "1", position: 1, label: "TX" }, { pinId: "2", position: 2, label: "RX" },
            { pinId: "3", position: 3, label: "GND" }
          ] }]
        } });
      }
      await window.teststand.projects.saveProject();
      await window.teststand.projects.leaveProject();
    }, projectRoot);
    await reloadAfterLeave(page);
    await page.getByText("wiring-fixture", { exact: true }).first().click();
    await page.getByRole("button", { name: "针脚列表", exact: true }).click();
    await expect(page.getByRole("region", { name: "针脚列表" })).toBeVisible();
  });
  test.afterAll(async () => {
    await app?.close().catch(() => undefined);
    if (userData && dirname(userData) === resolve(tmpdir())) await rm(userData, { recursive: true, force: true });
  });

  test("logs the change once a request is confirmed and nothing for a rejected one", async () => {
    const id = await page.evaluate(async () => (await window.teststand.wiring.requestTask({ input: { changes: [
      { action: "connect", portA: "DUT_A.J1", portB: "DUT_B.J1", pins: [{ a: "1", b: "2" }, { a: "3", b: "3" }] }
    ] } })).wiringTaskId);
    // The request is answered in the conversation: the log has no pending cards and nothing changed yet.
    await showPanel(page, "接线日志");
    const log = page.getByRole("region", { name: "接线日志" });
    const changes = log.getByRole("region", { name: "变更记录" });
    await expect(log.getByRole("region", { name: "待处理" })).toHaveCount(0);
    await expect(changes.getByText(/暂无接线变更/)).toBeVisible();
    expect(await page.evaluate((taskId) => window.teststand.wiring.getTask({ taskId }).then((task) => task.status), id)).toBe("pending");

    await page.evaluate((taskId) => window.teststand.wiring.completeTask({ taskId, outcome: "confirmed" }), id);
    const entry = changes.getByRole("listitem").filter({ hasText: "新增接线 DUT_A 串口 ↔ DUT_B 串口" });
    await expect(entry).toBeVisible();
    await expect(entry.getByLabel("AI 接线")).toBeVisible();
    await page.screenshot({ animations: "disabled", path: join(artifacts, "task-log.png") });
    await expect(cables(page)).toHaveCount(1);
    await log.getByRole("group", { name: "日志来源" }).getByRole("button", { name: "人工更改" }).click();
    await expect(changes.getByText(/暂无人工更改/)).toBeVisible();
    await log.getByRole("group", { name: "日志来源" }).getByRole("button", { name: "全部" }).click();

    const rejectedId = await page.evaluate(async () => (await window.teststand.wiring.requestTask({ input: { changes: [
      { action: "disconnect", portA: "DUT_A.J1", portB: "DUT_B.J1", pins: [{ a: "1", b: "2" }] }
    ] } })).wiringTaskId);
    await page.evaluate((taskId) => window.teststand.wiring.completeTask({ taskId, outcome: "rejected" }), rejectedId);
    expect(await page.evaluate((taskId) => window.teststand.wiring.getTask({ taskId }).then((task) => task.status), rejectedId)).toBe("rejected");
    await expect(changes.getByRole("listitem")).toHaveCount(1);
    await expect(cables(page)).toHaveCount(1);
  });

  test("lists same-port connections with the others", async () => {
    await page.getByRole("button", { name: "新建接线", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "新建接线", exact: true });
    await editor.getByLabel("起点端口", { exact: true }).selectOption("DUT_A.J1");
    await editor.getByLabel("终点端口", { exact: true }).selectOption("DUT_A.J1");
    await editor.getByLabel("起点针脚", { exact: true }).selectOption("1");
    await editor.getByLabel("终点针脚", { exact: true }).selectOption("1");
    await expect(editor.getByRole("button", { name: "创建接线" })).toBeDisabled();
    await editor.getByLabel("终点针脚", { exact: true }).selectOption("2");
    await editor.getByRole("button", { name: "创建接线" }).click();
    await expect(cables(page)).toHaveCount(2);
    await expect(page.getByRole("region", { name: "针脚列表" })).toContainText("同端口接线");
    await page.screenshot({ animations: "disabled", path: join(artifacts, "same-port-list.png") });
    expect(await page.evaluate(async () => (await window.teststand.projects.document())?.file.wiring.connections.length)).toBe(2);
    const taskId = await page.evaluate(async () => (await window.teststand.wiring.requestTask({ input: { changes: [
      { action: "disconnect", portA: "DUT_A.J1", portB: "DUT_A.J1", pins: [{ a: "1", b: "2" }] }
    ] } })).wiringTaskId);
    await page.evaluate((id) => window.teststand.wiring.completeTask({ taskId: id, outcome: "confirmed" }), taskId);
    await showPanel(page, "接线日志");
    const changes = page.getByRole("region", { name: "接线日志" }).getByRole("region", { name: "变更记录" });
    await expect(changes.getByText("删除接线 DUT_A 串口 ↔ DUT_A 串口")).toBeVisible();
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; document.documentElement.classList.add("dark"); });
    await page.setViewportSize({ width: 960, height: 600 });
    await page.screenshot({ animations: "disabled", path: join(artifacts, "same-port-dark-960.png") });
    expect(await page.evaluate((id) => window.teststand.wiring.getTask({ taskId: id }).then((task) => task.status), taskId)).toBe("confirmed");
    expect(await page.evaluate(async () => (await window.teststand.projects.document())?.file.wiring.connections.length)).toBe(1);
    expect(errors).toEqual([]);
  });
});

