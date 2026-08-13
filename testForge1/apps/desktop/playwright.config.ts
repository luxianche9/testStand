import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  outputDir: resolve(import.meta.dirname, "../../output/playwright/test-results"),
  reporter: [["list"], ["html", { outputFolder: resolve(import.meta.dirname, "../../output/playwright/report"), open: "never" }]],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  }
});
