import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { prepareUi } from "./prepare-ui.mjs";

const distDir = resolve(process.cwd(), "dist");
mkdirSync(distDir, { recursive: true });
prepareUi();

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
