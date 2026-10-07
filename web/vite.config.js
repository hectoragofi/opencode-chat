import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Single source of truth: root package.json (CI stamps it from the git tag).
const appVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8")).version;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Baked-in app version for the UI footer.
  define: {
    __APP_VERSION__: JSON.stringify(appVersion || "dev"),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "../public",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4096",
    },
  },
});
