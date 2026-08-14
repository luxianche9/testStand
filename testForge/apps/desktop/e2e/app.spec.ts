import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const desktopDir = resolve(import.meta.dirname, "..");
const workspaceDir = resolve(desktopDir, "../..");
const artifactDir = resolve(workspaceDir, "output/playwright");
const gatewayPort = 18080;

let application: ElectronApplication;
let page: Page;
let userDataDir: string;
let projectRoot: string;
const rendererErrors: string[] = [];

test.describe.serial("TestForge folder project desktop", () => {
  test.beforeAll(async () => {
    await mkdir(artifactDir, { recursive: true });
    userDataDir = await mkdtemp(resolve(tmpdir(), "testforge-e2e-"));
    projectRoot = join(userDataDir, "project-a");
    await mkdir(projectRoot);
    const env = { ...process.env, TESTFORGE_USER_DATA_DIR: userDataDir, TESTFORGE_GATEWAY_PORT: String(gatewayPort), TESTFORGE_AGENT_INTEGRATION_TEST_MODE: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ args: [desktopDir], cwd: desktopDir, env, timeout: 90_000 });
    page = await application.firstWindow({ timeout: 90_000 });
    page.setDefaultTimeout(60_000);
    page.on("pageerror", (error) => rendererErrors.push(error.stack ?? error.message));
    page.on("console", (message) => { if (message.type() === "error") rendererErrors.push(message.text()); });
  });

  test.afterAll(async () => {
    if (application) {
      const process = application.process();
      await Promise.race([application.close().catch(() => undefined), new Promise((resolveDelay) => setTimeout(resolveDelay, 10_000))]);
      if (process && !process.killed) {
        try { process.kill(); } catch { /* already exited */ }
        if (process.pid) await promisify(execFile)("taskkill", ["/PID", String(process.pid), "/T", "/F"]).catch(() => undefined);
      }
    }
    if (userDataDir?.startsWith(tmpdir())) await rm(userDataDir, { recursive: true, force: true });
  });

  test("starts on the welcome page and gates project-only navigation", async () => {
    await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
    await expect(page.getByRole("button", { name: "打开项目文件夹" })).toBeVisible();
    await expect(page.getByRole("button", { name: "设置", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "工位接线", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "打开 AI 侧栏" })).toHaveCount(0);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "设备管理", exact: true }).click();
    await expect(page.getByRole("heading", { name: "设备管理" })).toBeVisible();
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
    await page.screenshot({ path: resolve(artifactDir, "welcome-light.png"), fullPage: true });
    expect(await page.evaluate(() => typeof window.testforge)).toBe("object");
    expect(rendererErrors).toEqual([]);
  });

  test("initializes a folder project and exposes the full top navigation", async () => {
    const document = await page.evaluate((rootPath) => window.testforge.projects.initializeFolder(rootPath), projectRoot);
    expect(document.path.replaceAll("\\", "/")).toMatch(/\/\.testforge\/project\.json$/);
    await page.evaluate(() => window.testforge.projects.leave());
    await page.reload();
    // Every launch still returns to the welcome page even when recent projects exist.
    await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
    await page.getByText("project-a", { exact: true }).first().click();
    await expect(page.getByRole("tab", { name: "工位接线", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "编排测试", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "手动控制", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "运行日志", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "打开 AI 侧栏" })).toBeVisible();
  });

  test("registers hardware and keeps wiring and orchestration bodies intact", async () => {
    const result = await page.evaluate(async () => {
      for (const hardwareId of ["DUT_A", "DUT_B"]) {
        await window.testforge.devices.saveHardware({
          formatVersion: 2, hardwareId, label: hardwareId, kind: "passive",
          ports: [
            { portId: "J1", name: "J1", pins: [{ pinId: "1", position: 1, label: "A" }, { pinId: "2", position: 2, label: "B" }] },
            { portId: "FIBER", name: "光纤口", pins: [] }
          ]
        });
      }
      await window.testforge.wiring.update({ nodes: [
        { hardwareId: "DUT_A", x: 10, y: 10, showImage: true, portPositions: {} },
        { hardwareId: "DUT_B", x: 200, y: 10, showImage: true, portPositions: {} }
      ], connections: [] });
      const pending = await window.testforge.wiring.requestTask({ portA: "DUT_A.J1", portB: "DUT_B.J1", pins: [{ a: "1", b: "1" }, { a: "2", b: "2" }], action: "connect" });
      await window.testforge.wiring.startTask(pending.wiringTaskId, "e2e");
      await window.testforge.wiring.completeTask(pending.wiringTaskId, "confirmed");
      const beforeSave = await window.testforge.projects.current();
      const afterSave = await window.testforge.projects.save();
      return { beforeSave, afterSave };
    });
    expect(result.beforeSave?.dirty).toBe(true);
    expect(result.afterSave.dirty).toBe(false);
    expect(result.beforeSave?.file.wiring.connections[0]?.pins).toEqual([{ a: "1", b: "1" }, { a: "2", b: "2" }]);

    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "设备管理", exact: true }).click();
    await expect(page.getByRole("heading", { name: "设备管理" })).toBeVisible();
    await expect(page.getByRole("treeitem", { name: /DUT_A/ })).toBeVisible();
    await page.screenshot({ path: resolve(artifactDir, "devices-page.png"), fullPage: true });

    await page.getByRole("button", { name: "返回", exact: true }).click();
    await page.getByRole("tab", { name: "工位接线", exact: true }).click();
    await expect(page.getByText("硬件库")).toBeVisible();
    await expect(page.getByRole("button", { name: "接线调用历史" })).toBeVisible();
    await page.screenshot({ path: resolve(artifactDir, "project-wiring.png") });

    await page.getByRole("tab", { name: "编排测试", exact: true }).click();
    await expect(page.getByRole("button", { name: "应用" })).toBeVisible();
    await expect(page.getByRole("button", { name: "校验" })).toBeVisible();
    await expect(page.getByRole("button", { name: "运行" })).toBeVisible();
    await page.screenshot({ path: resolve(artifactDir, "project-orchestration.png") });
  });

  test("uses settings as the only configuration surface and switches themes", async () => {
    await page.getByRole("button", { name: "设置" }).click();
    await expect(page.getByRole("heading", { name: "外观" })).toBeVisible();
    await page.getByRole("button", { name: "深色 始终使用深色界面。" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: resolve(artifactDir, "settings-dark.png"), fullPage: true });

    await page.getByRole("button", { name: "AI 模型" }).click();
    await expect(page.getByLabel("Base URL")).toBeVisible();
    await expect(page.getByLabel("模型 ID")).toBeVisible();
    await expect(page.getByText("OpenCode", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Agent 接入" }).click();
    await expect(page.getByText("MCP Gateway", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Codex", { exact: true }).first()).toBeVisible();

    await page.getByRole("tab", { name: "工位接线", exact: true }).click();
    await page.getByRole("button", { name: "打开 AI 侧栏" }).click();
    const sidebar = page.locator(".tf-agent-sidebar");
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "打开模型设置" })).toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: "启动助手" })).toHaveCount(0);
    await expect(sidebar.getByLabel(/OpenCode 状态/)).toBeVisible();
    await page.screenshot({ path: resolve(artifactDir, "assistant-sidebar-dark.png") });
  });

  test("protects dirty project transitions with save, discard, and cancel", async () => {
    await page.evaluate(async () => {
      const current = await window.testforge.projects.current();
      if (!current) throw new Error("project missing");
      await window.testforge.wiring.update({ ...current.file.wiring, nodes: [...current.file.wiring.nodes, { hardwareId: "EXTRA", x: 300, y: 20, showImage: true, portPositions: {} }] });
    });
    await requestLeaveProject(page);
    const dialog = page.getByRole("dialog", { name: "保存项目修改" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "保存并继续" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "放弃修改" })).toBeVisible();
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("tab", { name: "工位接线", exact: true })).toBeVisible();
    await requestLeaveProject(page);
    await dialog.getByRole("button", { name: "放弃修改" }).click();
    await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
    await expect(page.getByRole("button", { name: "打开 AI 侧栏" })).toHaveCount(0);
  });

  test("exposes gateway tools and rejects project tools while no project is active", async () => {
    const token = await page.evaluate(() => window.testforge.agents.gatewayToken());
    const client = new Client({ name: "e2e", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("request_wiring_task");
    const task = await client.callTool({ name: "get_test_task", arguments: {} });
    expect(task.isError).toBeTruthy();
    await client.close();
    expect(rendererErrors).toEqual([]);
  });
});

async function requestLeaveProject(page: Page): Promise<void> {
  await page.getByRole("button", { name: "项目文件夹菜单" }).click();
  await page.getByRole("menuitem", { name: "退出", exact: true }).click();
}
