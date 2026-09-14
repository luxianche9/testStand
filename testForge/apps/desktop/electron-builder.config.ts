import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Configuration } from "electron-builder";

const desktopDir = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(import.meta.url);

const config: Configuration = {
  appId: "com.testforge.desktop",
  productName: "TestForge",
  artifactName: "TestForge-${version}-windows-${arch}.${ext}",
  directories: {
    output: resolve(desktopDir, "../../dist"),
    buildResources: resolve(desktopDir, "resources")
  },
  files: ["out/**/*", "package.json"],
  extraResources: [
    {
      from: resolve(desktopDir, "../../docs/shadcn"),
      to: "third-party/shadcn",
      filter: ["LICENSE.md", "README.md"]
    },
    {
      from: resolve(desktopDir, "../../python/dist/testforge-backend"),
      to: "backend"
    },
    {
      from: require.resolve("opencode-windows-x64-baseline/bin/opencode.exe"),
      to: "opencode/opencode.exe"
    },
    {
      from: resolve(desktopDir, "resources/opencode"),
      to: "opencode",
      filter: ["LICENSE", "VERSION", "THIRD_PARTY_NOTICES.txt"]
    },
    {
      from: resolve(desktopDir, "resources/assistant-ui"),
      to: "third-party/assistant-ui",
      filter: ["LICENSE", "SOURCE.txt"]
    },
    {
      from: resolve(desktopDir, "resources/fonts"),
      to: "third-party/fonts",
      filter: ["OFL-1.1.txt", "THIRD_PARTY_NOTICES.txt"]
    }
  ],
  win: {
    target: [{ target: "nsis", arch: ["x64"] }]
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowElevation: true
  }
};

export default config;
