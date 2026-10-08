import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { reloadAfterLeave, rendererReady, showPanel } from "./renderer.js";

const desktopDir = resolve(import.meta.dirname, "..");
const gatewayPort = 18082;

test("settings returns to the page that opened it", async () => {
  const userDataDir = await mkdtemp(resolve(tmpdir(), "teststand-settings-navigation-"));
  const projectRoot = join(userDataDir, "settings-navigation-project");
  await mkdir(projectRoot);
  const env = { ...process.env, TESTSTAND_USER_DATA_DIR: userDataDir, TESTSTAND_GATEWAY_PORT: String(gatewayPort), TESTSTAND_AGENT_INTEGRATION_TEST_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: [desktopDir], cwd: desktopDir, env, timeout: 90_000 });
  try {
    const page = await rendererReady(await application.firstWindow({ timeout: 90_000 }));
    page.setDefaultTimeout(30_000);

    await openSettingsAndReturn(page, () => expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible());

    await page.evaluate((rootPath) => window.teststand.projects.initializeFolder({ rootPath }), projectRoot);
    await page.evaluate(() => window.teststand.projects.leaveProject());
    await reloadAfterLeave(page);
    await page.getByText("settings-navigation-project", { exact: true }).first().click();

    const devices = page.getByRole("complementary", { name: "设备列表" });
    await expect(devices).toBeVisible();
    await openSettingsAndReturn(page, () => expect(devices).toBeVisible());

    await showPanel(page, "测试编排");
    const editFlow = page.getByRole("toolbar", { name: "测试流程操作" }).getByRole("button", { name: "编辑" });
    await expect(editFlow).toBeEnabled();
    await openSettingsAndReturn(page, () => expect(editFlow).toBeEnabled());

  } finally {
    await application.close().catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

async function openSettingsAndReturn(page: Page, assertReturned: () => Promise<void>) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "外观" })).toBeVisible();
  await page.getByRole("button", { name: "AI 模型" }).click();
  await expect(page.getByRole("heading", { name: "AI 模型" })).toBeVisible();
  // The activity bar's 设置 icon toggles: a second click returns, as 返回 does.
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await assertReturned();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await assertReturned();
}
