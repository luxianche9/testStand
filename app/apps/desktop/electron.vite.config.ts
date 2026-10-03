import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { defaultClientConditions, defaultServerConditions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  main: {
    resolve: { conditions: ["teststand-source", ...defaultServerConditions] },
    ssr: { resolve: { conditions: ["teststand-source", ...defaultServerConditions], externalConditions: ["teststand-source", ...defaultServerConditions] } },
    plugins: [externalizeDepsPlugin({ exclude: [
      "@teststand/contracts",
      "electron-log"
    ] })],
    build: {
      rollupOptions: {
        external: [/^@modelcontextprotocol\/sdk(?:\/|$)/, /^ajv(?:\/|$)/, "zod"]
      }
    }
  },
  preload: {
    resolve: { conditions: ["teststand-source", ...defaultServerConditions] },
    ssr: { resolve: { conditions: ["teststand-source", ...defaultServerConditions], externalConditions: ["teststand-source", ...defaultServerConditions] } },
    plugins: [externalizeDepsPlugin({ exclude: ["@teststand/contracts"] })],
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
    resolve: { conditions: ["teststand-source", ...defaultClientConditions], alias: { "@renderer": fileURLToPath(new URL("./src/renderer", import.meta.url)) } },
    plugins: [react(), tailwindcss()],
    esbuild: { minifyIdentifiers: false },
    build: { minify: "esbuild" }
  }
});
