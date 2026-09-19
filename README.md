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
src-tauri/             Rust 网关、Tauri 入口、SQLite 和托盘
web/src/               React 控制台
scripts/auth.ts        一次性认证捕获工具
scripts/auth-support.ts 认证缓存、Provider 捕获规则和配置读取
assets/icons/          应用与托盘图标
```

运行时只包含 Rust/Tauri 网关；认证工具在首次捕获凭据时使用 Node 和 mitmweb，网关运行时不会启动它们。

## 安装、开发和打包

```bash
npm install
npm run typecheck
npm test
npm run build
npm run desktop
```

常用命令：

```bash
npm run desktop             # Tauri 开发模式，启动托盘、Axum 和 React
npm run serve:rust          # 仅启动 Rust/Axum 网关
npm run package:tauri       # 构建当前平台安装包
npm run package:macos       # 构建 macOS .app 和 .dmg
npm run auth                # 捕获 MiMo/WorkBuddy 认证缓存
```

发布包不需要额外安装 Node。Tauri 开发模式使用 Vite 的 `127.0.0.1:1420`，网关默认监听 `127.0.0.1:3000`。控制台通过 `VITE_GATEWAY_BASE_URL` 访问 Axum 服务，发布构建已经设置为 `http://127.0.0.1:3000`。

## 首次认证

认证工具会启动 mitmweb 和对应的桌面客户端，等待成功请求，然后只保存 Cookie、Authorization 和 X-* 请求头：

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
MAX_BODY_BYTES=1048576
MODEL_DISCOVERY=true
MODEL_DISCOVERY_TIMEOUT_MS=30000
# WORKBUDDY_MODEL_FILE=/path/to/WorkBuddy/product.json
# DEFAULT_MODEL=provider/model-id
# CORS_ORIGIN=http://localhost:1420
```

debug 模式默认使用项目下的 `.runtime`；release 应用默认使用系统用户数据目录。macOS 路径为 `~/Library/Application Support/LLM Gateway`。设置 `RUNTIME_DIR` 可以固定到其他目录。

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
npm test
npm run build:web:tauri
npm run package:tauri
```
