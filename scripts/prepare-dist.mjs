import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const distDir = resolve(process.cwd(), "dist");
mkdirSync(distDir, { recursive: true });

// Remove the old Perry-native launcher so it cannot be mistaken for the
// stable Node/TypeScript process orchestrator.
rmSync(resolve(distDir, "mimo-launcher"), { force: true });
