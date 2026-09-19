import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const webRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const projectRoot = resolve(webRoot, "..");

export default defineConfig({
  root: webRoot,
  envPrefix: ["VITE_", "SYNC_URL"],
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(projectRoot, ".build/web"),
    emptyOutDir: true,
    assetsDir: "assets",
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        format: "iife",
        entryFileNames: "gateway.js",
        assetFileNames: "gateway.[ext]"
      }
    }
  }
});
