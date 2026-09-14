import { defineConfig } from "vitest/config";

// Resolve @hardwareharness/* workspace packages from TypeScript source (see the
// "hardwareharness-source" exports condition in each package's package.json).
const conditions = ["hardwareharness-source", "module", "node", "import", "default"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    exclude: ["e2e/**", "**/node_modules/**", "**/dist/**", "**/out/**"]
  }
});
