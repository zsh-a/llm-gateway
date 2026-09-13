import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const distDir = resolve(process.cwd(), "dist");
mkdirSync(distDir, { recursive: true });

// Remove stale generated artifacts from previous project layouts.
for (const staleFile of [
  "llm-gateway-ui",
  "mimo-chat",
  "mimo-server",
  "scripts/launch.js",
  "src/auth.js",
  "src/mimo.js",
  "src/ui.js"
]) {
  rmSync(resolve(distDir, staleFile), { force: true });
}
