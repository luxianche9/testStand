import { expect, type Page } from "@playwright/test";

/** The renderer installs `window.teststand` when its bundle runs, after the window exists. */
export async function rendererReady(page: Page): Promise<Page> {
  await page.waitForFunction(() => typeof window.teststand === "object");
  return page;
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
