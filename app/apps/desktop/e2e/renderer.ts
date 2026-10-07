import { expect, type Page } from "@playwright/test";

/** The renderer installs `window.teststand` when its bundle runs, after the window exists. */
export async function rendererReady(page: Page): Promise<Page> {
  await page.waitForFunction(() => typeof window.teststand === "object");
  return page;
}

/** The activity bar at the window's left edge. */
export function activityBar(page: Page) {
  return page.getByRole("navigation", { name: "活动栏" });
}

/** Show a sidebar panel (设备, 测试, 运行记录, 接线日志); a click on the shown one would fold it away. */
export async function showPanel(page: Page, label: string): Promise<void> {
  const button = activityBar(page).getByRole("button", { name: label, exact: true });
  if (await button.getAttribute("aria-pressed") !== "true") await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

/**
 * Reload after a test changed and left the project through the API. Events only invalidate queries, so the
 * interface may still hold a dirty document for a moment, and its dirty-project guard would cancel the unload
 * (Electron shows no dialog for it). Wait for the welcome page and for the coalesced refetches (≤ 500 ms).
 */
export async function reloadAfterLeave(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "最近项目" })).toBeVisible();
  await page.waitForTimeout(600);
  await page.reload();
  await rendererReady(page);
}
