import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = resolve(projectRoot, "dist/llm-gateway");
const appBundle = resolve(projectRoot, "dist/LLM Gateway.app");
const contentsDir = join(appBundle, "Contents");
const macOsDir = join(contentsDir, "MacOS");
const resourcesDir = join(contentsDir, "Resources");
const appBinary = join(macOsDir, "llm-gateway");
const plistPath = join(contentsDir, "Info.plist");

if (!existsSync(binary)) {
  console.error("未找到 dist/llm-gateway，请先执行 npm run build");
  process.exit(1);
}

mkdirSync(macOsDir, { recursive: true });
mkdirSync(resourcesDir, { recursive: true });
copyFileSync(binary, appBinary);
chmodSync(appBinary, 0o755);

const configuredIcon = process.env.TRAY_ICON_PATH?.trim();
if (configuredIcon && existsSync(resolve(projectRoot, configuredIcon))) {
  const extension = extname(configuredIcon).toLowerCase();
  const iconName = extension === ".icns"
    ? "tray.icns"
    : extension === ".ico"
      ? "tray.ico"
      : "tray.png";
  copyFileSync(resolve(projectRoot, configuredIcon), join(resourcesDir, iconName));
}

const plist = [
  "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
  "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
  "<plist version=\"1.0\">",
  "  <dict>",
  "    <key>CFBundleDisplayName</key>",
  "    <string>LLM Gateway</string>",
  "    <key>CFBundleExecutable</key>",
  "    <string>llm-gateway</string>",
  "    <key>CFBundleIdentifier</key>",
  "    <string>com.llm-gateway.app</string>",
  "    <key>CFBundleName</key>",
  "    <string>LLM Gateway</string>",
  "    <key>CFBundlePackageType</key>",
  "    <string>APPL</string>",
  "    <key>CFBundleShortVersionString</key>",
  "    <string>1.0.0</string>",
  "    <key>CFBundleVersion</key>",
  "    <string>1</string>",
  "    <key>LSUIElement</key>",
  "    <true/>",
  "    <key>NSHighResolutionCapable</key>",
  "    <true/>",
  "  </dict>",
  "</plist>",
  ""
].join("\n");
writeFileSync(plistPath, plist);

console.log("已生成 macOS 应用: " + appBundle);
