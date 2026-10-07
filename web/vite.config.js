import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Single source of truth: root package.json (CI stamps it from the git tag).
const appVersion = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8")).version;
// Build stamp so stale-UI reports are answerable at a glance (footer shows it).
// Falls back to a timestamp when git is unavailable.
let buildId = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
try {
  const hash = execSync("git rev-parse --short HEAD", { cwd: path.resolve(__dirname, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (hash) buildId = `${buildId}-${hash}`;
} catch { /* outside git — keep the timestamp */ }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Baked-in app version for the UI footer.
  define: {
    __APP_VERSION__: JSON.stringify(appVersion || "dev"),
    __BUILD_ID__: JSON.stringify(buildId),
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
