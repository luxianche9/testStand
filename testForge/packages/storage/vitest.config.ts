import { defineConfig } from "vitest/config";

// Resolve @testforge/* workspace packages from TypeScript source (see the
// "testforge-source" exports condition in each package's package.json).
const conditions = ["testforge-source", "module", "node", "import", "default"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } }
});
