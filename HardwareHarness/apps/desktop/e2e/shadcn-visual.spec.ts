import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

const desktopDir = resolve(import.meta.dirname, "..");
const workspace = resolve(desktopDir, "../..");
const phase = process.env.HARDWAREHARNESS_VISUAL_PHASE ?? "after";
const artifactRoot = resolve(workspace, "reports/applications/visual", phase);
const sizes = [{ width: 960, height: 600 }, { width: 1280, height: 800 }, { width: 1600, height: 1000 }];
let referenceServer: Server | undefined;
let referenceUrl: string | undefined;

test.beforeAll(async () => {
  const root = process.env.HARDWAREHARNESS_VISUAL_REFERENCE_DIR;
  if (!root) return;
  const mime: Record<string, string> = { js: "text/javascript", css: "text/css", html: "text/html", woff2: "font/woff2", svg: "image/svg+xml" };
  referenceServer = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const target = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!target.startsWith(resolve(root) + "/") && !target.startsWith(resolve(root) + "\\")) { response.writeHead(403).end(); return; }
    void readFile(target).then((body) => {
      response.setHeader("Content-Type", mime[target.split(".").at(-1)!] ?? "application/octet-stream");
      response.end(body);
    }).catch(() => response.writeHead(404).end());
  });
  await new Promise<void>((resolveListen) => referenceServer!.listen(0, "127.0.0.1", resolveListen));
  const address = referenceServer.address();
  if (!address || typeof address === "string") throw new Error("Reference server address unavailable");
  referenceUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  referenceServer?.closeAllConnections();
  if (referenceServer) await new Promise<void>((resolveClose) => referenceServer!.close(() => resolveClose()));
});

async function navigateProject(page: Page, view: "设备管理" | "工位接线" | "动作编排" | "运行日志"): Promise<void> {
  // The existing compact navigation hides its text below 1100px; order is unchanged.
  const tabs = page.getByRole("tablist", { name: "项目子页面" }).getByRole("tab");
  await expect(tabs).toHaveCount(4);
  await tabs.nth(["设备管理", "工位接线", "动作编排", "运行日志"].indexOf(view)).click();
}

async function capture(page: Page, group: string, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const controls = await page.locator("button,input,select,textarea,[role=tab],[role=treeitem]").evaluateAll((elements) => elements
    .filter((element) => element.getClientRects().length > 0)
    .map((element) => ({
      tag: element.tagName,
      role: element.getAttribute("role"),
      type: element.getAttribute("type"),
      name: (element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.textContent ?? "")
        .replace(/\s+/g, " ").trim().replace(/[A-Z]:\\.*?\\shadcn-fixture/g, "<PROJECT_ROOT>").replace(/更新于 .*/, "更新于 <UPDATED_AT>"),
      disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
      options: element instanceof HTMLSelectElement ? Array.from(element.options, (option) => ({ text: option.text, value: option.value, disabled: option.disabled })) : undefined
    })));
  const directory = join(artifactRoot, group);
  await mkdir(directory, { recursive: true });
  if (phase === "after" && process.env.HARDWAREHARNESS_VISUAL_COMPARE === "1") {
    const baseline = JSON.parse(await readFile(resolve(workspace, "reports/shadcn/visual", process.env.HARDWAREHARNESS_VISUAL_BASELINE ?? "reference", group, `${name}.json`), "utf8"));
    expect(controls, `${group}/${name}: existing controls, labels, native options and disabled states`).toEqual(baseline);
  }
  await writeFile(join(directory, `${name}.json`), `${JSON.stringify(controls, null, 2)}\n`);
  await page.screenshot({ path: join(directory, `${name}.png`), animations: "disabled", scale: "css" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const theme of ["light", "dark", "system"] as const) {
  for (const size of sizes) {
    const group = `${theme}-${size.width}x${size.height}`;
    test(`preserves desktop controls and captures ${group}`, async () => {
      const userData = await mkdtemp(join(tmpdir(), "hardwareharness-skin-"));
      const projectRoot = join(userData, "shadcn-fixture");
      await mkdir(projectRoot);
      const executablePath = process.env.HARDWAREHARNESS_DESKTOP_EXECUTABLE;
      const env = { ...process.env, HARDWAREHARNESS_USER_DATA_DIR: userData, HARDWAREHARNESS_GATEWAY_PORT: "0", HARDWAREHARNESS_AGENT_INTEGRATION_TEST_MODE: "1" };
      delete env.ELECTRON_RUN_AS_NODE;
      if (referenceUrl) env.ELECTRON_RENDERER_URL = referenceUrl;
      const application = await electron.launch({
        ...(executablePath ? { executablePath } : {}),
        args: executablePath ? [] : [desktopDir],
        cwd: executablePath ? dirname(executablePath) : desktopDir, env
      });
      try {
        const page = await application.firstWindow();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await application.evaluate(({ BrowserWindow }, bounds) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          window.setMinimumSize(0, 0);
          window.setContentSize(bounds.width, bounds.height);
        }, size);
        await page.setViewportSize(size);
        await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
        await page.evaluate(async ({ theme, projectRoot }) => {
          await window.hardwareharness.settings.setTheme(theme);
          await window.hardwareharness.projects.initializeFolder(projectRoot);
          for (const hardwareId of ["DUT_A", "DUT_B"]) {
            await window.hardwareharness.devices.saveHardware({ formatVersion: 2, hardwareId, label: hardwareId, kind: "passive", ports: [
              { portId: "J1", name: "信号接口", pins: [{ pinId: "1", position: 1, label: "信号" }, { pinId: "2", position: 2, label: "地" }] }
            ] });
          }
          await window.hardwareharness.wiring.update({ nodes: [
            { hardwareId: "DUT_A", x: 20, y: 20, showImage: true, portPositions: {} },
            { hardwareId: "DUT_B", x: 340, y: 60, showImage: true, portPositions: {} }
          ], connections: [] });
          const pending = await window.hardwareharness.wiring.requestTask({ portA: "DUT_A.J1", portB: "DUT_B.J1", action: "connect", pins: [{ a: "1", b: "1" }] });
          await window.hardwareharness.wiring.startTask(pending.wiringTaskId);
          await window.hardwareharness.wiring.completeTask(pending.wiringTaskId, "confirmed");
          await window.hardwareharness.applications.createFile({ path: "scripts/visual.py", kind: "file", content: "def main(inputs):\n    return inputs\n" });
          await window.hardwareharness.projects.save();
          await window.hardwareharness.projects.leave();
        }, { theme, projectRoot });
        await page.emulateMedia({ colorScheme: theme === "light" ? "light" : "dark" });
        await page.reload();
        await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme === "system" ? "dark" : theme);
        await capture(page, group, "welcome");
        await page.getByText("shadcn-fixture", { exact: true }).first().click();
        await expect(page.getByText("硬件库", { exact: true })).toBeVisible();
        await capture(page, group, "wiring");
        await navigateProject(page, "设备管理");
        await expect(page.getByRole("treeitem", { name: /DUT_A/ })).toBeVisible();
        await capture(page, group, "devices");
        await navigateProject(page, "动作编排");
        await expect(page.getByRole("listbox", { name: "Python 脚本列表" })).toBeVisible();
        await capture(page, group, "applications");
        await navigateProject(page, "运行日志");
        await expect(page.getByRole("heading", { name: "运行日志", exact: true })).toBeVisible();
        await capture(page, group, "logs");
        await page.locator("button").filter({ hasText: /^设置$/ }).click();
        await expect(page.getByRole("heading", { name: "外观", exact: true })).toBeVisible();
        await capture(page, group, "settings-appearance");
        await page.getByRole("button", { name: "AI 模型", exact: true }).click();
        await expect(page.getByLabel("Base URL")).toBeVisible();
        await capture(page, group, "settings-model");
        await page.getByRole("button", { name: "Agent 接入", exact: true }).click();
        await expect(page.getByText("MCP Gateway", { exact: false }).first()).toBeVisible();
        await capture(page, group, "settings-agent");
        await navigateProject(page, "工位接线");
        await page.getByRole("button", { name: "打开 AI 侧栏", exact: true }).click();
        await expect(page.locator(".tf-agent-sidebar")).toBeVisible();
        await expect(page.getByRole("heading", { name: "先完成模型配置", exact: true })).toBeVisible();
        await capture(page, group, "agent-sidebar");
        await page.getByRole("button", { name: "关闭 AI 侧栏", exact: true }).click();
        await page.evaluate(async () => {
          const current = await window.hardwareharness.projects.current();
          if (!current) throw new Error("Project missing");
          await window.hardwareharness.wiring.update({ ...current.file.wiring, nodes: current.file.wiring.nodes.map((node) => ({ ...node, x: node.x + 1 })) });
        });
        await page.getByRole("button", { name: "项目文件夹菜单", exact: true }).click();
        await page.getByRole("menuitem", { name: "退出", exact: true }).click();
        const dirty = page.getByRole("dialog", { name: "保存项目修改" });
        await expect(dirty).toBeVisible();
        await capture(page, group, "dirty-dialog");
        await dirty.getByRole("button", { name: "取消", exact: true }).click();
        expect(errors).toEqual([]);
      } finally {
        await application.close();
        await rm(userData, { recursive: true, force: true });
      }
    });
  }
}
