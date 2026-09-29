// Standalone preview server for renderer prototypes (mock data, no Electron): pnpm exec vite --config vite.demo.config.ts
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
  resolve: {
    conditions: ["hardwareharness-source", ...defaultClientConditions],
    alias: { "@renderer": fileURLToPath(new URL("./src/renderer", import.meta.url)) }
  },
  plugins: [react(), tailwindcss()],
  server: { port: 5199, strictPort: true, open: "/run-console-demo.html" }
});
