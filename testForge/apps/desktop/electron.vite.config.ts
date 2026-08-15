import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
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
  renderer: { plugins: [react(), tailwindcss()] }
});
