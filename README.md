# LLM Gateway

LLM Gateway 是一个本地 OpenAI 兼容网关。Rust 负责长期运行的网络和存储，Tauri 2 负责系统托盘与窗口，React 负责管理控制台。

```text
Tauri 2
  ├── 托盘与窗口
  ├── Tokio + Axum HTTP 服务
  │     └── Reqwest → MiMo / WorkBuddy
  ├── SQLite：渠道、虚拟 API Key、请求指标
  └── React + Vite：管理控制台

独立认证工具（Node/TypeScript）
  mitmweb + Provider 客户端 → .runtime/auth/*.json
```

## 目录

```text
src-tauri/src/gateway/ Rust 网关 HTTP、协议、认证、指标和模型目录
src-tauri/src/desktop.rs Tauri 启动与系统托盘
src-tauri/src/service.rs 网关生命周期与优雅退出（独立于窗口）
web/src/               React + Vite + Tailwind 控制台、Base UI 交互组件和 TanStack Query 状态管理
web/src/features/      按功能组织的页面与业务组件
web/tests/             表单、键盘交互、数据查询及流式响应回归测试
cloudflare/sync-worker/ Cloudflare 加密认证同步 Worker
scripts/auth.ts        一次性认证捕获工具
scripts/auth-support.ts 认证缓存、Provider 捕获规则和配置读取
src-tauri/icons/       应用与托盘图标
```

运行时只包含 Rust/Tauri 网关；认证工具在首次捕获凭据时使用 Node 和 mitmweb，网关运行时不会启动它们。

## 安装、开发和打包

```bash
npm install
npm run typecheck
npm run test:frontend
npm test
npm run build
npm run desktop
```

常用命令：

```bash
npm run desktop             # Tauri 开发模式，启动托盘、Axum 和 React
npm run serve:headless      # 无窗口、无托盘，仅启动 Rust/Axum 网关
npm run serve:rust          # serve:headless 的兼容别名
npm run package:tauri       # 构建当前平台安装包
npm run package:macos       # 构建 macOS .app 和 .dmg
npm run auth                # 捕获 MiMo/WorkBuddy 认证缓存
npm run sync -- status      # 查看远端认证保险库版本
npm run sync -- push        # 加密并上传本机认证缓存
npm run sync -- pull        # 下载并解密认证缓存
```

发布包不需要额外安装 Node。Tauri 开发模式使用 Vite 的 `127.0.0.1:1420`，网关默认监听 `127.0.0.1:3000`。桌面控制台从本机服务读取实际访问地址；独立浏览器模式使用 `VITE_GATEWAY_BASE_URL`，未设置时默认使用 `http://127.0.0.1:3000`。

## 桌面托盘

- 手动启动会打开控制台；关闭窗口仅隐藏到托盘，网关继续服务。重复启动会唤醒已有实例；macOS 点击 Dock 图标也会恢复窗口。
- 窗口大小、位置和最大化状态会保存；隐藏、最小化状态不作为下次主动打开的状态恢复。启动参数 `--background` 可仅启动托盘，不显示窗口（不等于注册开机自启）。
- 托盘显示真实服务状态、进行中的模型请求数和访问地址。端口占用等启动错误会显示原因并打开设置页面。
- “服务操作”支持启动、停止和重启 HTTP 服务，不必退出桌面应用。Windows 左键打开控制台、右键展开菜单；macOS 点击菜单栏图标展开菜单。
- “复制 OpenAI Base URL”复制包含 `/v1` 的地址，并显示成功或失败反馈。监听 `0.0.0.0` / `::` 时复制本机回环地址，IPv6 自动补齐方括号；供其他机器访问时应改用本机实际 IP。
- 停止、重启、保存监听配置和正常退出会先停止接收新模型请求，等待现有请求及流式响应结束。超过 15 秒只提示，不自动中断；用户可在“服务操作”中选择“强制退出（中断请求）”，或在控制台确认强制退出。
- 服务不可用时，控制台显示恢复入口，暂停自动查询并禁用新模型请求和管理写操作；已打开的工作台流式响应继续等待完成。

本批实现未包含开机自启开关、自动更新或日志文件管理。强制终止进程、系统强制关机不保证完成请求排空。

## Headless 模式

Headless 模式只启动 Rust/Axum 网关，不创建 Tauri 窗口和系统托盘，适合服务器、容器和
systemd/launchd 服务：

```bash
npm run serve:headless

# 或直接运行主二进制的 headless 参数
cargo run --release --manifest-path src-tauri/Cargo.toml -- --headless
```

现有主程序也支持 `--headless` 参数或 `HEADLESS=1` 环境变量：

```bash
./src-tauri/target/release/llm-gateway --headless
HEADLESS=1 ./src-tauri/target/release/llm-gateway
```

Headless 服务默认监听 `127.0.0.1:3000`。如果需要远程访问，请设置
`BIND_HOST=0.0.0.0` 并同时配置 `PROXY_API_KEY` 与 `PROXY_ADMIN_KEY`。
收到 SIGINT、SIGTERM 或 Windows Ctrl-C 后，服务会停止接收新连接并优雅退出。

## GitHub Actions 发布

[`.github/workflows/desktop.yml`](./.github/workflows/desktop.yml) 会在 Pull Request、`main`
分支推送和手动运行时执行检查并上传构建产物。构建矩阵包含：

```text
Windows x64       .msi / .exe
macOS arm64       .dmg
```

发布版本时创建并推送 `v*` 标签：

```bash
git tag v1.0.0
git push origin v1.0.0
```

标签工作流会创建 GitHub Release 并上传所有平台安装包。当前 macOS 构建使用临时签名，适合测试和内部分发；正式公开分发还需要配置 Apple Developer 证书和公证。

## 首次认证

认证工具会启动 mitmweb 和对应的桌面客户端，等待成功请求，然后保存 Cookie、Authorization 和 X-* 请求头；WorkBuddy 还会保存模型配置接口要求的 User-Agent 客户端版本：

```bash
npm run auth
npm run auth -- --provider mimo
npm run auth -- --provider workbuddy --force
npm run auth -- --provider workbuddy --no-client
```

缓存保存于：

```text
.runtime/auth/mimo.json
.runtime/auth/workbuddy.json
```

如需给指定 Channel 捕获凭据：

```bash
npm run auth -- --provider mimo --channel mimo-secondary
```

## 多机认证同步

`cloudflare/sync-worker` 是可独立部署的同步服务。Worker 只保存客户端使用
`scrypt + AES-256-GCM` 加密后的认证包，不接触 Cookie、Authorization 或 `X-*`
请求头明文。

部署 Worker：

```bash
cd cloudflare/sync-worker
npm install
npx wrangler secret put SYNC_TOKEN
npm run deploy
```

在每台机器上设置相同的同步地址、Token 和保险库 ID，然后使用同一个同步密码：

```bash
export SYNC_URL=https://<worker-domain>
export SYNC_TOKEN=<worker-token>
export SYNC_VAULT_ID=personal
export SYNC_PASSPHRASE='use-a-long-local-passphrase'

npm run sync -- push
npm run sync -- pull --force
```

桌面控制台的“同步服务地址”会优先使用已保存的地址；首次打开时也可以通过构建环境变量
`VITE_SYNC_URL`（或 `SYNC_URL`）预填。同步地址不是密钥，可以写入前端构建配置。

`push` 默认使用本机保存的远端版本进行冲突检测；确认覆盖远端时使用
`--force`。不要同步整个 `.runtime` 或 SQLite 文件。

桌面应用也支持在“设置 → 远端认证同步”中检查远端版本并拉取认证。同步 Token
只保存在当前桌面会话中，加密密码不会保存；拉取成功后网关会立即重新加载认证缓存。
普通浏览器页面不具备本地解密和写入权限，仍需使用桌面应用完成拉取。

WorkBuddy 模型目录在网关启动时和桌面拉取认证成功后自动获取。网关使用登录凭据请求
`https://copilot.tencent.com/v3/config`，无需目标设备安装 WorkBuddy，也无需把模型目录重新上传到云端。
旧认证包未保存 User-Agent 时会使用兼容版本头；新捕获的认证会保留客户端原有版本头。
模型请求复用 5 分钟缓存，到期后下次查询会重新获取。成功结果只保存模型元数据到
`RUNTIME_DIR/models/workbuddy.json`；认证失效、网络失败或返回空目录时不会覆盖已有目录。
远程失败后依次尝试 `WORKBUDDY_MODEL_FILE`、网关模型缓存、WorkBuddy 用户缓存和 macOS 安装目录。
`MODEL_DISCOVERY=false` 会关闭远程及本地发现，仅返回内置默认模型。

认证工具的代理、客户端入口和证书参数见 [.env.example](./.env.example)。

## 运行配置

```bash
PORT=3000
BIND_HOST=127.0.0.1
# PROXY_API_KEY=change-me
# PROXY_ADMIN_KEY=admin-change-me
RUNTIME_DIR=./.runtime
# AUTH_CACHE_DIR=./.runtime/auth
# DATABASE_FILE=./.runtime/gateway.sqlite3
REQUEST_TIMEOUT_MS=180000
MAX_BODY_BYTES=8388608
MODEL_DISCOVERY=true
MODEL_DISCOVERY_TIMEOUT_MS=30000
METRICS_MAX_RECORDS=2000
# WORKBUDDY_MODEL_FILE=/path/to/WorkBuddy/product.json
# DEFAULT_MODEL=provider/model-id
# CORS_ORIGIN=http://localhost:1420
```

桌面应用可以在“设置 → 服务监听”中配置 Host 和 Port，保存后自动重启并写入
`RUNTIME_DIR/service.json`。环境变量 `BIND_HOST` 和 `PORT` 优先级更高，适合 headless、容器和
systemd/launchd 服务。debug 模式默认使用项目下的 `.runtime`；release 应用默认使用系统用户数据目录。
macOS 路径为 `~/Library/Application Support/LLM Gateway`。设置 `RUNTIME_DIR` 可以固定到其他目录。

HTTP 请求体默认上限为 8 MiB（8,388,608 字节），由 `MAX_BODY_BYTES` 控制；它按整个 JSON 的
字节数计算，与模型的 token 上下文限制无关，历史 `reasoning_content` 和 tool 输出也会占用。
Chat Completions / Responses 请求超限时返回 HTTP 413 和 `request_body_too_large`，错误中包含
当前上限；`/.well-known/llm-gateway/capabilities` 的 `limits.maxBodyBytes` 也会返回生效值。
如需调整，请在启动网关的进程环境中设置该变量，然后完全退出并重新启动。仅修改 `.env.example`
不会生效；已设置的环境变量会覆盖默认值。旧版默认 1 MiB 的网关也可通过设置
`MAX_BODY_BYTES=8388608` 提高上限，无需改动模型配置。

SQLite 默认路径为 `RUNTIME_DIR/gateway.sqlite3`。启动时会从旧的 `channels.json` 和 `api-keys.json` 做一次性导入；后续管理数据以 SQLite 为准。

## HTTP 接口

```text
GET    /health
GET    /health/live
GET    /health/ready
GET    /health/auth
GET    /.well-known/llm-gateway/capabilities
GET    /v1/models
POST   /v1/chat/completions
POST   /v1/responses
GET    /metrics/summary
GET    /metrics/timeseries
GET    /metrics/requests
GET    /admin/channels
POST   /admin/channels
DELETE /admin/channels/{id}
GET    /admin/keys
POST   /admin/keys
PATCH  /admin/keys/{id}
DELETE /admin/keys/{id}
GET    /admin/metrics/summary
GET    /admin/metrics/timeseries
GET    /admin/metrics/requests
```

Chat Completions 支持流式和非流式调用。网关以流式方式请求上游，`stream: false` 时在 Rust 内聚合响应。模型可直接使用原始 ID，也可以使用 `mimo/model-id` 或 `workbuddy/model-id` 指定 Provider。

Responses 的非流式请求会转换为标准 `response` 对象；流式 Responses 当前透传上游 SSE。Chat 的流式指标、usage、超时、客户端断开和渠道重试由 Rust 网关处理。

## 管理渠道和 Key

本地监听且未配置管理员 Key 时，管理 API 可直接访问。远程监听必须配置 `PROXY_ADMIN_KEY`。

```bash
curl -X POST http://127.0.0.1:3000/admin/channels \
  -H 'Content-Type: application/json' \
  -d '{"id":"mimo-secondary","providerId":"mimo","authRef":"mimo-secondary","priority":50}'

curl -X POST http://127.0.0.1:3000/admin/keys \
  -H 'Content-Type: application/json' \
  -d '{"name":"local-client","allowedModels":["mimo-pro"],"rpmLimit":60}'
```

API Key 只在创建响应中返回一次完整 secret，SQLite 只保存 hash 和脱敏前缀。渠道按优先级选择，遇到可重试的上游错误时尝试后续渠道。

## 验证

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run typecheck
npm run check:frontend
npm run test:frontend
npm run test:auth
npm test
npm run build:web:tauri
npm run package:tauri
```
