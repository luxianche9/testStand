import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { reloadAfterLeave, rendererReady } from "./renderer.js";

const desktopDir = resolve(import.meta.dirname, "..");

test.describe.serial("desktop controls preserve real keyboard and pointer interactions", () => {
  let application: ElectronApplication;
  let page: Page;
  let userData: string;

  test.beforeAll(async () => {
    userData = await mkdtemp(join(tmpdir(), "hardwareharness-shadcn-interactions-"));
    const projectRoot = join(userData, "interaction-fixture");
    await mkdir(projectRoot);
    const executablePath = process.env.HARDWAREHARNESS_DESKTOP_EXECUTABLE;
    const env = Object.fromEntries(Object.entries({
      ...process.env,
      HARDWAREHARNESS_USER_DATA_DIR: userData,
      HARDWAREHARNESS_GATEWAY_PORT: "0",
      HARDWAREHARNESS_AGENT_INTEGRATION_TEST_MODE: "1"
    }).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args: executablePath ? [] : [desktopDir],
      cwd: executablePath ? dirname(executablePath) : desktopDir,
      env,
      timeout: 90_000
    });
    page = await rendererReady(await application.firstWindow({ timeout: 90_000 }));
    page.setDefaultTimeout(30_000);
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setMinimumSize(0, 0);
      window.setContentSize(1280, 800);
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
    await page.evaluate(async (root) => {
      await window.hardwareharness.projects.initializeFolder(root);
      for (const hardwareId of ["DUT_A", "DUT_B"]) {
        await window.hardwareharness.devices.saveHardware({
          formatVersion: 2, hardwareId, label: hardwareId, kind: "passive",
          ports: [{ portId: "J1", name: "信号接口", pins: [{ pinId: "1", position: 1, label: "信号" }] }]
        });
      }
      await window.hardwareharness.wiring.update({ nodes: [
        { hardwareId: "DUT_A", x: 20, y: 20, width: 220, height: 140, portPositions: { J1: { side: "right", offset: 0.5 } } },
        { hardwareId: "DUT_B", x: 360, y: 60, width: 160, height: 48, portPositions: { J1: { side: "left", offset: 0.5 } } }
      ], connections: [] });
      await window.hardwareharness.projects.save();
      await window.hardwareharness.projects.leave();
    }, projectRoot);
    await reloadAfterLeave(page);
    await page.getByText("interaction-fixture", { exact: true }).first().click();
    await expect(page.locator('[data-hardware-id="DUT_A"]')).toBeVisible();
  });

  test.afterAll(async () => {
    await application?.close().catch(() => undefined);
    if (userData && dirname(userData) === resolve(tmpdir())) await rm(userData, { recursive: true, force: true });
  });

  test("drags a canvas port and node without changing card geometry", async () => {
    const node = page.locator('[data-hardware-id="DUT_A"]');
    const wrapper = page.locator('.react-flow__node[data-id="DUT_A"]');
    await expect(wrapper).toHaveCSS("width", "220px");
    await expect(wrapper).toHaveCSS("height", "140px");
    await expect(page.locator('.react-flow__node[data-id="DUT_B"]')).toHaveCSS("height", "48px");
    await node.click({ button: "right" });
    await page.getByRole("menuitem", { name: "改变端口位置", exact: true }).click();
    await expect(node).toHaveAttribute("data-connector-editing", "true");
    const card = (await node.boundingBox())!;
    const port = (await node.getByRole("button", { name: "拖动端口 信号接口", exact: true }).boundingBox())!;
    await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2);
    await page.mouse.down();
    await page.mouse.move(card.x + card.width / 4, card.y, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => readNode(page, "DUT_A").then((item) => item.portPositions.J1?.side)).toBe("top");
    const afterPort = await readNode(page, "DUT_A");
    expect(afterPort.portPositions.J1?.offset).toBeCloseTo(0.25, 1);
    expect(afterPort).toMatchObject({ x: 20, y: 20, width: 220, height: 140 });
    await page.keyboard.press("Escape");
    await expect(node).toHaveAttribute("data-connector-editing", "false");

    const caption = (await node.locator(".flow-node-caption").boundingBox())!;
    const zoom = card.width / 220;
    await page.mouse.move(caption.x + caption.width / 2, caption.y + caption.height / 2);
    await page.mouse.down();
    await page.mouse.move(caption.x + caption.width / 2 + 36, caption.y + caption.height / 2 + 24, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => readNode(page, "DUT_A").then((item) => item.x)).toBeGreaterThan(20);
    const afterMove = await readNode(page, "DUT_A");
    // ReactFlow begins moving only after its pointer activation threshold.
    expect(Math.abs((afterMove.x - 20) * zoom - 36)).toBeLessThanOrEqual(4);
    expect(Math.abs((afterMove.y - 20) * zoom - 24)).toBeLessThanOrEqual(4);
    const movedCard = (await node.boundingBox())!;
    expect(movedCard.x - card.x).toBeCloseTo((afterMove.x - 20) * zoom, 0);
    expect(movedCard.y - card.y).toBeCloseTo((afterMove.y - 20) * zoom, 0);
    expect(afterMove).toMatchObject({ width: 220, height: 140, portPositions: afterPort.portPositions });
    await expect(wrapper).toHaveCSS("width", "220px");
    await expect(wrapper).toHaveCSS("height", "140px");
    const rootPath = await page.evaluate(async () => {
      const current = (await window.hardwareharness.projects.current())!;
      await window.hardwareharness.projects.leave();
      return current.rootPath;
    });
    await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
    await page.evaluate((root) => window.hardwareharness.projects.openFolder(root), rootPath);
    await page.reload();
    await page.getByText("interaction-fixture", { exact: true }).first().click();
    await expect(page.getByRole("tab", { name: "工位接线", exact: true })).toBeVisible();
    expect(await readNode(page, "DUT_A")).toEqual(afterMove);
  });

  test("restores each panel width after navigating and reloading", async () => {
    const panels = [
      { tab: "工位接线", label: "调整侧栏宽度" },
      { tab: "设备管理", label: "拖拽调整面板宽度" }
    ];
    const widths: number[] = [];
    for (const panel of panels) {
      await page.getByRole("tab", { name: panel.tab, exact: true }).click();
      const separator = page.getByRole("separator", { name: panel.label, exact: true });
      const bounds = (await separator.boundingBox())!;
      await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + 62, bounds.y + bounds.height / 2, { steps: 8 });
      await page.mouse.up();
      widths.push(await separator.evaluate((element) => parseFloat((element.parentElement as HTMLElement).style.gridTemplateColumns)));
    }
    await page.reload();
    await page.getByText("interaction-fixture", { exact: true }).first().click();
    for (const [index, panel] of panels.entries()) {
      await page.getByRole("tab", { name: panel.tab, exact: true }).click();
      const separator = page.getByRole("separator", { name: panel.label, exact: true });
      await expect.poll(() => separator.evaluate((element) => parseFloat((element.parentElement as HTMLElement).style.gridTemplateColumns))).toBe(widths[index]);
    }
    await page.getByRole("tab", { name: "工位接线", exact: true }).click();
  });

  test("resizes the sidebar from the keyboard and retains its bounded width", async () => {
    await page.getByRole("button", { name: "打开 AI 侧栏", exact: true }).click();
    const separator = page.getByRole("separator", { name: "调整 AI 助手侧栏宽度" });
    const sidebar = page.locator(".tf-agent-sidebar");
    await separator.focus();
    await separator.press("Home");
    await expect(separator).toBeFocused();
    await expect(separator).toHaveAttribute("aria-valuenow", "300");
    await expect(sidebar).toHaveCSS("width", "300px");
    await separator.press("ArrowRight");
    await expect(sidebar).toHaveCSS("width", "300px");
    await separator.press("ArrowLeft");
    await expect(sidebar).toHaveCSS("width", "316px");
    await separator.press("End");
    await expect(sidebar).toHaveCSS("width", "720px");
    await separator.press("ArrowLeft");
    await expect(sidebar).toHaveCSS("width", "720px");
    await page.setViewportSize({ width: 960, height: 600 });
    await expect(sidebar).toHaveCSS("width", "492px");
    await expect(separator).toHaveAttribute("aria-valuemax", "492");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "关闭 AI 侧栏", exact: true }).click();
    await page.getByRole("button", { name: "打开 AI 侧栏", exact: true }).click();
    await expect(sidebar).toHaveCSS("width", "492px");
    await page.getByRole("button", { name: "关闭 AI 侧栏", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test("keeps empty native Select options and keyboard selection with same-port support", async () => {
    await page.getByRole("group", { name: "接线视图" }).getByRole("button", { name: "列表", exact: true }).click();
    await page.getByRole("button", { name: "新建接线", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建接线", exact: true });
    const source = dialog.getByLabel("起点端口");
    const target = dialog.getByLabel("终点端口");
    const create = dialog.getByRole("button", { name: "创建接线", exact: true });
    await expect(source).toHaveValue("");
    await expect(target).toHaveValue("");
    await expect(create).toBeDisabled();
    expect(await source.evaluate((element) => element.tagName)).toBe("SELECT");
    await expect(source.locator('option[value=""]')).toHaveText("选择端口");
    await source.focus();
    await source.press("ArrowDown");
    await expect(source).toHaveValue("DUT_A.J1");
    await expect(target.locator('option[value="DUT_A.J1"]')).toHaveJSProperty("disabled", false);
    await target.focus();
    await target.press("ArrowDown");
    await expect(target).toHaveValue("DUT_A.J1");
    await expect(create).toBeDisabled();
    await target.press("ArrowDown");
    await expect(target).toHaveValue("DUT_B.J1");
    await expect(create).toBeEnabled();
    await expect(dialog.getByLabel("起点针脚")).toHaveValue("1");
    await expect(dialog.getByLabel("终点针脚")).toHaveValue("1");
    await source.focus();
    await source.press("Home");
    await expect(source).toHaveValue("");
    await expect(create).toBeDisabled();
    await expect(target.locator('option[value="DUT_A.J1"]')).toHaveJSProperty("disabled", false);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(async () => (await window.hardwareharness.projects.current())?.file.wiring.connections)).toEqual([]);
  });

  test("submits the computer editor with Enter and the keyboard-selected native shell", async () => {
    await page.getByRole("tab", { name: "设备管理", exact: true }).click();
    await page.getByRole("button", { name: "添加电脑", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "添加电脑", exact: true });
    await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    await dialog.getByLabel("电脑 ID").fill("KEYBOARD_PC");
    await dialog.getByLabel("显示名称").fill("Keyboard computer");
    await dialog.getByLabel("IP 地址 / 主机名").fill("127.0.0.1");
    await dialog.getByLabel("SSH 用户名").fill("keyboard");
    const shell = dialog.getByLabel("Shell");
    await expect(shell).toHaveValue("powershell");
    await shell.focus();
    await shell.press("End");
    await expect(shell).toHaveValue("posix");
    await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
    await dialog.getByLabel("SSH 用户名").press("Enter");
    await expect(dialog).toBeHidden();
    const saved = await page.evaluate(async () => (await window.hardwareharness.system.dashboard()).computers.find((computer) => computer.id === "KEYBOARD_PC"));
    expect(saved).toMatchObject({
      id: "KEYBOARD_PC", label: "Keyboard computer", address: "127.0.0.1",
      ssh: { port: 22, username: "keyboard", shell: "posix" }
    });
  });

  test("discards unsaved hardware editor changes on Escape", async () => {
    await page.getByRole("tab", { name: "设备管理", exact: true }).click();
    const hardware = page.getByRole("tree", { name: "硬件列表" }).getByRole("treeitem", { name: /DUT_A/ });
    await hardware.click();
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "编辑硬件", exact: true });
    await editor.getByLabel("显示名称").fill("Unsaved keyboard edit");
    await page.keyboard.press("Escape");
    await expect(editor).toBeHidden();
    await expect(hardware).toContainText("DUT_A");
    await expect(hardware).not.toContainText("Unsaved keyboard edit");
  });

  test("restores the window and saved layout after restarting the desktop", async () => {
    const node = await readNode(page, "DUT_A");
    const savedWidths = await page.evaluate(() => Object.fromEntries(
      Object.keys(localStorage).filter((key) => key.endsWith("-width") || key.endsWith(".width"))
        .map((key) => [key, localStorage.getItem(key)])
    ));
    const dimensions = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setSize(1180, 760);
      return window.getSize();
    });
    await application.close();
    const executablePath = process.env.HARDWAREHARNESS_DESKTOP_EXECUTABLE;
    const env = Object.fromEntries(Object.entries({
      ...process.env,
      HARDWAREHARNESS_USER_DATA_DIR: userData,
      HARDWAREHARNESS_GATEWAY_PORT: "0",
      HARDWAREHARNESS_AGENT_INTEGRATION_TEST_MODE: "1"
    }).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args: executablePath ? [] : [desktopDir],
      cwd: executablePath ? dirname(executablePath) : desktopDir,
      env,
      timeout: 90_000
    });
    page = await rendererReady(await application.firstWindow({ timeout: 90_000 }));
    // Windows display scaling can round logical window dimensions by one pixel.
    await expect.poll(async () => {
      const actual = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getSize());
      return Math.max(...actual.map((value, index) => Math.abs(value - dimensions[index]!)));
    }).toBeLessThanOrEqual(1);
    expect(await page.evaluate((keys) => Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])), Object.keys(savedWidths))).toEqual(savedWidths);
    await page.getByText("interaction-fixture", { exact: true }).first().click();
    await expect(page.getByRole("tab", { name: "工位接线", exact: true })).toBeVisible();
    expect(await readNode(page, "DUT_A")).toEqual(node);
    await page.getByRole("tab", { name: "工位接线", exact: true }).click();
    const separator = page.getByRole("separator", { name: "调整侧栏宽度", exact: true });
    await expect.poll(() => separator.evaluate((element) => parseFloat((element.parentElement as HTMLElement).style.gridTemplateColumns))).toBe(Number(savedWidths["hardwareharness.wiring-library-width"]));
  });
});

async function readNode(page: Page, hardwareId: string) {
  return await page.evaluate(async (id) => {
    const node = (await window.hardwareharness.projects.current())?.file.wiring.nodes.find((item) => item.hardwareId === id);
    if (!node) throw new Error(`Missing canvas node: ${id}`);
    return node;
  }, hardwareId);
}
