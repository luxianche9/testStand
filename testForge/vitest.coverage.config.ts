import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/contracts",
      "apps/desktop"
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/out/**", "**/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      include: ["packages/*/src/**/*.ts", "apps/desktop/src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*.d.ts",
        "apps/desktop/src/renderer/main.tsx",
        "apps/desktop/src/renderer/global.d.ts"
      ],
      thresholds: {
        lines: 50,
        functions: 60,
        branches: 65,
        statements: 50
      }
    }
  }
});
