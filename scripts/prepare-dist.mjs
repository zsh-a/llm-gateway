import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { prepareUi } from "./prepare-ui.mjs";

const distDir = resolve(process.cwd(), "dist");
mkdirSync(distDir, { recursive: true });
prepareUi();
