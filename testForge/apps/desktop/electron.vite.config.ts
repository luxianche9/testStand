import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { defaultClientConditions, defaultServerConditions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    resolve: { conditions: ["testforge-source", ...defaultServerConditions] },
    ssr: { resolve: { conditions: ["testforge-source", ...defaultServerConditions], externalConditions: ["testforge-source", ...defaultServerConditions] } },
    plugins: [externalizeDepsPlugin({ exclude: [
      "@testforge/application",
      "@testforge/contracts",
      "@testforge/devices",
      "@testforge/mcp-gateway",
      "@testforge/orchestration",
      "@testforge/projects",
      "@testforge/storage",
      "@testforge/wiring",
      "@trpc/server",
      "electron-log",
      "electron-trpc"
    ] })],
    build: {
      rollupOptions: {
        external: [/^@modelcontextprotocol\/sdk(?:\/|$)/, /^ajv(?:\/|$)/, "ssh2", "zod"]
      }
    }
  },
  preload: {
    resolve: { conditions: ["testforge-source", ...defaultServerConditions] },
    ssr: { resolve: { conditions: ["testforge-source", ...defaultServerConditions], externalConditions: ["testforge-source", ...defaultServerConditions] } },
    plugins: [externalizeDepsPlugin({ exclude: ["@testforge/contracts", "@trpc/client", "@trpc/server", "electron-trpc"] })],
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs"
        }
      }
    }
  },
  renderer: {
    resolve: { conditions: ["testforge-source", ...defaultClientConditions] },
    plugins: [react(), tailwindcss()]
  }
});
