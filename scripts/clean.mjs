import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const directory of ["dist", ".build", ".generated", ".test-dist"]) {
  rmSync(resolve(projectRoot, directory), { recursive: true, force: true });
}
