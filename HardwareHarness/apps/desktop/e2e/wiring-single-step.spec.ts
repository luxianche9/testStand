import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const desktopDir = resolve(import.meta.dirname, "..");
const artifacts = resolve(desktopDir, "../../output/playwright/wiring-single-step");

test.describe.serial("single-step wiring inbox", () => {
  let app: ElectronApplication;
  let page: Page;
  let userData: string;
  const errors: string[] = [];
  test.beforeAll(async () => {
    userData = await mkdtemp(join(tmpdir(), "hardwareharness-wiring-inbox-"));
    const projectRoot = join(userData, "wiring-fixture");
    await mkdir(projectRoot);
    await mkdir(artifacts, { recursive: true });
    const env = { ...process.env, HARDWAREHARNESS_USER_DATA_DIR: userData,
      HARDWAREHARNESS_GATEWAY_PORT: "0", HARDWAREHARNESS_AGENT_INTEGRATION_TEST_MODE: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [desktopDir], cwd: desktopDir, env, timeout: 90_000 });
    page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setMinimumSize(0, 0);
      BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800);
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
    await page.evaluate(async (root) => {
      await window.hardwareharness.projects.initializeFolder(root);
      for (const hardwareId of ["DUT_A", "DUT_B"]) {
        await window.hardwareharness.devices.saveHardware({
          formatVersion: 2, hardwareId, label: hardwareId, kind: "passive",
          ports: [{ portId: "J1", name: "串口", imageAssetId: "port.png", pins: [
            { pinId: "1", position: 1, label: "TX" }, { pinId: "2", position: 2, label: "RX" },
            { pinId: "3", position: 3, label: "GND" }
          ] }]
        });
      }
      await window.hardwareharness.wiring.update({ nodes: [
        { hardwareId: "DUT_A", x: 20, y: 20, width: 220, height: 140, showImage: false, portPositions: { J1: { side: "right", offset: 0.5 } } },
        { hardwareId: "DUT_B", x: 380, y: 20, width: 220, height: 140, showImage: false, portPositions: { J1: { side: "left", offset: 0.5 } } }
      ], connections: [] });
      await window.hardwareharness.projects.save();
      await window.hardwareharness.projects.leave();
    }, projectRoot);
    for (const id of ["DUT_A", "DUT_B"]) await copyFile(
      resolve(desktopDir, "../../../mcp_servers/hardware-manuals/stm32-batianhu-v2/images/J1.png"),
      join(userData, "devices/hardware", id, "port.png")
    );
    await page.reload();
    await page.getByText("wiring-fixture", { exact: true }).first().click();
    await expect(page.locator('.react-flow__node[data-id="DUT_A"]')).toBeVisible();
  });
  test.afterAll(async () => {
    await app?.close().catch(() => undefined);
    if (userData && dirname(userData) === resolve(tmpdir())) await rm(userData, { recursive: true, force: true });
  });

  test("defers a request, reopens from the inbox, previews photos, and completes in one click", async () => {
    await page.getByRole("tab", { name: "设备管理", exact: true }).click();
    const id = await page.evaluate(async () => (await window.hardwareharness.wiring.requestTask({
      portA: "DUT_A.J1", portB: "DUT_B.J1", action: "connect",
      pins: [{ a: "1", b: "2" }, { a: "3", b: "3" }]
    })).wiringTaskId);
    const modal = page.getByRole("dialog", { name: "接线任务", exact: true });
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("button", { name: "已完成", exact: true })).toBeEnabled();
    await expect(modal.getByRole("button", { name: "开始处理" })).toHaveCount(0);
    await expect(modal.locator("img").first()).toHaveJSProperty("complete", true);
    await page.screenshot({ animations: "disabled", path: join(artifacts, "pending-light.png") });
    await modal.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("tab", { name: "工位接线", exact: true }).click();
    await expect(modal).toHaveCount(0);
    expect(await page.evaluate((taskId) => window.hardwareharness.wiring.getTask(taskId).then((task) => task.status), id)).toBe("pending");
    await page.getByRole("button", { name: "信箱", exact: true }).click();
    await page.getByRole("dialog", { name: "信箱", exact: true }).getByRole("button", { name: /待处理.*连接/ }).click();
    await modal.getByRole("button", { name: "查看全图：DUT_A · 串口" }).click();
    await expect(page.getByRole("dialog", { name: "DUT_A · 串口", exact: true })).toBeVisible();
    await page.screenshot({ animations: "disabled", path: join(artifacts, "full-photo.png") });
    await page.keyboard.press("Escape");
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "已完成", exact: true }).click();
    await expect(modal.getByText("已完成", { exact: true })).toBeVisible();
    await expect(modal.getByRole("button", { name: "已完成", exact: true })).toHaveCount(0);
    await modal.getByRole("button", { name: "关闭", exact: true }).last().click();
    await page.getByRole("button", { name: "信箱", exact: true }).click();
    await page.getByRole("dialog", { name: "信箱", exact: true }).getByRole("button", { name: /已完成.*连接/ }).click();
    await expect(modal.getByText("已完成", { exact: true })).toBeVisible();
    await modal.getByRole("button", { name: "关闭", exact: true }).last().click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  });

  test("retains same-port connections in the list but hides them in React Flow", async () => {
    await page.getByRole("button", { name: "列表", exact: true }).click();
    await page.getByRole("button", { name: "新建接线", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "新建接线", exact: true });
    await editor.getByLabel("起点端口", { exact: true }).selectOption("DUT_A.J1");
    await editor.getByLabel("终点端口", { exact: true }).selectOption("DUT_A.J1");
    await editor.getByLabel("起点针脚", { exact: true }).selectOption("1");
    await editor.getByLabel("终点针脚", { exact: true }).selectOption("1");
    await expect(editor.getByRole("button", { name: "创建接线" })).toBeDisabled();
    await editor.getByLabel("终点针脚", { exact: true }).selectOption("2");
    await editor.getByRole("button", { name: "创建接线" }).click();
    await expect(page.getByRole("button", { name: /DUT_A.*↔.*DUT_A/ })).toBeVisible();
    await page.getByRole("button", { name: /DUT_A.*↔.*DUT_A/ }).click();
    await page.screenshot({ animations: "disabled", path: join(artifacts, "same-port-list.png") });
    await page.getByRole("button", { name: "画布", exact: true }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    expect(await page.evaluate(async () => (await window.hardwareharness.projects.current())?.file.wiring.connections.length)).toBe(2);
    const taskId = await page.evaluate(async () => (await window.hardwareharness.wiring.requestTask({
      portA: "DUT_A.J1", portB: "DUT_A.J1", pins: [{ a: "1", b: "2" }], action: "disconnect"
    })).wiringTaskId);
    const modal = page.getByRole("dialog", { name: "断线任务", exact: true });
    await expect(modal).toBeVisible();
    await expect(modal.locator("article")).toHaveCount(1);
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; document.documentElement.classList.add("dark"); });
    await page.setViewportSize({ width: 960, height: 600 });
    await page.screenshot({ animations: "disabled", path: join(artifacts, "same-port-dark-960.png") });
    await modal.getByRole("button", { name: "已完成", exact: true }).click();
    await expect(modal.getByText("已完成", { exact: true })).toBeVisible();
    expect(await page.evaluate((id) => window.hardwareharness.wiring.getTask(id).then((task) => task.status), taskId)).toBe("confirmed");
    expect(await page.evaluate(async () => (await window.hardwareharness.projects.current())?.file.wiring.connections.length)).toBe(1);
    expect(errors).toEqual([]);
  });
});

