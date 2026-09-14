import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { defaultClientConditions, defaultServerConditions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  main: {
    resolve: { conditions: ["testforge-source", ...defaultServerConditions] },
    ssr: { resolve: { conditions: ["testforge-source", ...defaultServerConditions], externalConditions: ["testforge-source", ...defaultServerConditions] } },
    plugins: [externalizeDepsPlugin({ exclude: [
      "@testforge/contracts",
      "@trpc/server",
      "electron-log",
      "electron-trpc"
    ] })],
    build: {
      rollupOptions: {
        external: [/^@modelcontextprotocol\/sdk(?:\/|$)/, /^ajv(?:\/|$)/, "zod"]
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
    resolve: { conditions: ["testforge-source", ...defaultClientConditions], alias: { "@renderer": fileURLToPath(new URL("./src/renderer", import.meta.url)) } },
    plugins: [react(), tailwindcss()],
    esbuild: { minifyIdentifiers: false },
    build: { minify: "esbuild" }
  }
});
