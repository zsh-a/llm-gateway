import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const distDir = resolve(process.cwd(), "dist");
mkdirSync(distDir, { recursive: true });

// Remove artifacts from the former combined launcher/auth implementation.
for (const staleFile of [
  "mimo-chat",
  "mimo-server",
  "scripts/launch.js",
  "src/auth.js",
  "src/mimo.js"
]) {
  rmSync(resolve(distDir, staleFile), { force: true });
}
