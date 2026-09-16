import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  readFileSync(join(projectRoot, "package.json"), "utf8")
);
const expectedVersion = packageJson.devDependencies?.["@perryts/perry"];

function isPerryWorkspace(directory) {
  return existsSync(join(directory, "Cargo.toml"));
}

function expandHome(value) {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/")) {
    return join(process.env.HOME ?? "", value.slice(2));
  }
  return value;
}

function workspaceCandidates() {
  const explicit = process.env.PERRY_WORKSPACE_ROOT?.trim();
  if (explicit) return [resolve(expandHome(explicit))];

  const candidates = [
    resolve(projectRoot, "../perry"),
    resolve(projectRoot, "../Perry"),
    resolve(projectRoot, "../../perry"),
    resolve(projectRoot, ".perry-source"),
    "/tmp/perry",
    tmpdir()
  ];

  for (const directory of ["/tmp", tmpdir()]) {
    try {
      for (const name of readdirSync(directory)) {
        if (name.startsWith("perry-workspace.")) {
          candidates.push(join(directory, name));
        }
      }
    } catch {
      // A missing or unreadable temporary directory is not fatal.
    }
  }

  return [...new Set(candidates)];
}

function findWorkspace() {
  const candidates = workspaceCandidates().filter(isPerryWorkspace);
  if (candidates.length === 0) return null;

  // Prefer the newest temporary workspace when several auto-generated ones
  // are present; explicit and adjacent paths retain their normal priority.
  return candidates.sort((left, right) => {
    const leftTemporary = left.includes("perry-workspace.");
    const rightTemporary = right.includes("perry-workspace.");
    if (leftTemporary !== rightTemporary) return leftTemporary ? 1 : -1;
    try {
      return statSync(right).mtimeMs - statSync(left).mtimeMs;
    } catch {
      return 0;
    }
  })[0];
}

function failWithoutWorkspace() {
  const version = expectedVersion ? ` ${expectedVersion}` : "";
  console.error(`未找到 Perry${version} 源码工作区，无法链接 node:http 扩展。`);
  console.error("请先执行：");
  console.error(
    `  git clone --depth 1 --branch v${expectedVersion ?? "0.5.1520"} https://github.com/PerryTS/perry.git ../perry`
  );
  console.error("  export PERRY_WORKSPACE_ROOT=\"$PWD/../perry\"");
  process.exit(1);
}

const [entry, output] = process.argv.slice(2);
if (!entry || !output) {
  console.error("用法: node scripts/build-native.mjs <entry.ts> <output>");
  process.exit(2);
}

const workspace = findWorkspace();
if (!workspace) failWithoutWorkspace();

const outputPath = resolve(projectRoot, output);
mkdirSync(dirname(outputPath), { recursive: true });

console.log(`Perry workspace: ${workspace}`);
const result = spawnSync(
  "perry",
  ["compile", entry, "-o", outputPath],
  {
    cwd: projectRoot,
    env: { ...process.env, PERRY_WORKSPACE_ROOT: workspace },
    stdio: "inherit"
  }
);

if (result.error) {
  console.error(`无法执行 perry: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
