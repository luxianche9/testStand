import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

const desktopDir = resolve(import.meta.dirname, "..");
const gatewayPort = 18082;

test("settings returns to the page that opened it", async () => {
  const userDataDir = await mkdtemp(resolve(tmpdir(), "testforge-settings-navigation-"));
  const projectRoot = join(userDataDir, "settings-navigation-project");
  await mkdir(projectRoot);
  const env = { ...process.env, TESTFORGE_USER_DATA_DIR: userDataDir, TESTFORGE_GATEWAY_PORT: String(gatewayPort), TESTFORGE_AGENT_INTEGRATION_TEST_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ args: [desktopDir], cwd: desktopDir, env, timeout: 90_000 });
  try {
    const page = await application.firstWindow({ timeout: 90_000 });
    page.setDefaultTimeout(30_000);

    await openSettingsAndReturn(page, () => expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible());

    await page.evaluate((rootPath) => window.testforge.projects.initializeFolder(rootPath), projectRoot);
    await page.evaluate(() => window.testforge.projects.leave());
    await page.reload();
    await page.getByText("settings-navigation-project", { exact: true }).first().click();

    await expect(page.getByText("硬件库", { exact: true })).toBeVisible();
    await openSettingsAndReturn(page, () => expect(page.getByText("硬件库", { exact: true })).toBeVisible());

    await page.getByRole("tab", { name: "编排测试" }).click();
    await expect(page.getByRole("button", { name: "应用" })).toBeVisible();
    await openSettingsAndReturn(page, () => expect(page.getByRole("button", { name: "应用" })).toBeVisible());

    await page.getByRole("tab", { name: "设备管理" }).click();
    await expect(page.getByRole("heading", { name: "设备管理" })).toBeVisible();
    await openSettingsAndReturn(page, () => expect(page.getByRole("heading", { name: "设备管理" })).toBeVisible());

    await page.getByRole("tab", { name: "运行日志" }).click();
    await expect(page.getByRole("heading", { name: "运行日志" })).toBeVisible();
    await openSettingsAndReturn(page, () => expect(page.getByRole("heading", { name: "运行日志" })).toBeVisible());
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
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await assertReturned();
}
