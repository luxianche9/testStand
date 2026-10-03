import { defineConfig } from "vitest/config";

// Resolve @teststand/* workspace packages from TypeScript source (see the
// "teststand-source" exports condition in each package's package.json).
const conditions = ["teststand-source", "module", "node", "import", "default"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } }
});
