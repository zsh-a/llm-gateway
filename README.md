# LLM Gateway

一个用 TypeScript 编写、由 Perry 编译核心服务的统一 OpenAI 兼容网关。
当前内置 MiMo 和 WorkBuddy 两个 Provider，客户端只需要配置一次网关地址，模型会自动路由到对应上游。

认证流程与网关运行时完全分离：`npm run auth` 负责首次捕获并缓存认证；网关和 Web 控制面板由同一个二进制提供 `serve`、`desktop` 两种模式。

## 架构

```text
首次认证（独立工具）
  npm run auth
      │ 启动 mitmweb / 桌面客户端、捕获请求头
      ▼
  .runtime/auth/mimo.json
  .runtime/auth/workbuddy.json
      │ 只读缓存
      ▼
同一个 Perry 编译二进制
  serve   → OpenAI Client → ModelCatalog → Provider → LLM 上游
  desktop → 托管 serve 子进程 + 嵌入式 Web 控制台
```

核心代码：

```text
src/app/            配置、依赖组合根、网关应用服务和应用错误
src/domain/         JSON 边界、领域类型、推理能力和 Provider 无关事件
src/auth/           认证缓存、虚拟 API Key 和安全策略
src/routing/        Channel、模型描述解析、模型目录和模型路由
src/providers/      Provider 契约、通用适配器、内置实现、注册表和故障切换
src/protocols/      Chat/Responses、流、SSE 和工具历史协议适配
src/infrastructure/ 文件存储和 Responses 会话存储
src/observability/  请求指标和用量归一化
src/transport/http/ HTTP 类型、工具、协议处理器和服务器装配
src/embedded-ui/    Web 控制台嵌入入口及生成资源声明
src/cli/main.ts     serve / desktop 模式入口
src/cli/management.ts doctor / models / export 管理命令
web/src/            React + Tailwind + shadcn/ui 控制台源码
scripts/auth.ts         一次性认证引导工具
scripts/clean.mjs       清理构建、测试和临时产物
scripts/prepare-ui.mjs  Vite 构建并将 Web 资源内嵌到 Perry
tests/                  Node 原生回归测试（编译后使用 node:test）
.build/                 构建阶段临时目录（不发布、不提交）
```

`serve` 模式只运行网关；`desktop` 模式由同一个入口托管 Gateway 子进程并打开同源 Web 控制台。控制台直接由 Gateway 提供，不需要额外的静态服务器、前端运行时或 CORS 配置。
Web 控制台使用 Tailwind CSS v4 和 shadcn/ui 风格的本地组件，资源由 Vite 在构建阶段编译并打入二进制，运行时不依赖 CDN 或额外静态服务器。
认证工具仍然独立，不会被网关或桌面模式自动启动。

## 安装与构建

```bash
npm install
npm run typecheck
npm test
npm run build
```

构建和运行已拆开：日常启动不会重复编译原生二进制；源码变更后再执行 `npm run build`，或使用 `npm run dev` 一次完成构建和启动。

如果 Perry 找不到网络扩展或标准库源码，准备对应版本的 Perry 工作区：

```bash
git clone --depth 1 --branch v0.5.1520 https://github.com/PerryTS/perry.git ../perry
export PERRY_WORKSPACE_ROOT="$PWD/../perry"
npm run build
```

产物：

```text
dist/llm-gateway
dist/auth/scripts/auth.js
```

常用管理命令：

```bash
npm run doctor                 # 检查运行目录、认证缓存和模型目录
npm run models                 # 输出当前 OpenAI 模型目录 JSON
npm run export:harness         # 输出 DeepSeek Harness 的 settings.yaml 片段
```

`export:harness` 只输出配置，不会修改 Harness 文件；它会把当前自动发现的 Chat 模型、上下文窗口、最大输出和 reasoning 档位生成到一个统一的 `llm-gateway` Provider 下。

## 前端代码质量

前端源码使用 Biome 统一处理格式化、导入排序和静态检查：

```bash
npm run format          # 格式化 web/src
npm run format:check   # 仅检查格式
npm run lint            # 运行前端 lint
npm run check:frontend  # 同时检查格式、导入和 lint
```

提交前建议至少运行 `npm run check:frontend` 和 `npm run typecheck`。

## 首次认证

认证所有内置 Provider：

```bash
npm run auth
```

只认证一个 Provider：

```bash
npm run auth -- --provider mimo
npm run auth -- --provider workbuddy
```

重新捕获：

```bash
npm run auth -- --provider workbuddy --force
```

认证工具会：

1. 启动 mitmweb。
2. 自动探测对应桌面客户端入口，并同时注入 Chromium 代理参数和 `HTTP_PROXY/HTTPS_PROXY` 环境变量（macOS 的 WorkBuddy 使用应用包内的 `Electron`）。
3. 等待对应上游的成功认证或模型请求。
4. 只保存 `Cookie`、`Authorization`、`X-*` 等认证请求头。
5. 退出桌面客户端和 mitmweb。

如果桌面客户端报 `ERR_CERT_AUTHORITY_INVALID`，优先安装并信任 mitmproxy CA；本机调试也可以设置：

```bash
CLIENT_IGNORE_CERT_ERRORS=true npm run auth -- --provider workbuddy
```

认证工具会自动将 `~/.mitmproxy/mitmproxy-ca-cert.pem` 注入客户端的 Node TLS 信任链；如果 mitmproxy 使用了自定义证书目录，可通过 `MITM_CA_CERT` 指定证书路径。

如果客户端已经手动启动，可以使用：

```bash
npm run auth -- --provider workbuddy --no-client
```

如果客户端安装在非标准位置，可以显式指定入口：

```bash
CLIENT_BIN="/path/to/client" npm run auth -- --provider workbuddy
```

认证完成后检查：

```bash
ls .runtime/auth
```

## 启动模式

认证完成后，后台或无图形环境运行 `serve` 模式：

```bash
npm run start
# 等价于：
# ./dist/llm-gateway serve
```

桌面端一键启动 Gateway 和控制面板：

```bash
npm run desktop
# 等价于：
# ./dist/llm-gateway desktop
```

`desktop` 会由同一个二进制托管 Gateway 子进程并打开浏览器控制台：`http://127.0.0.1:3000/ui`。控制台按“概览 / Playground / 统计 / 渠道与 Key / 设置”分成独立页面：概览查看网关、Provider、认证和模型状态，Playground 发送真实流式测试请求并支持停止、重试、复制和模型上下文跳转，统计支持 1 小时、24 小时、7 天、30 天以及 Provider、模型、状态筛选和请求分页；“渠道与 Key”页面在输入 `PROXY_ADMIN_KEY` 后维护 Channel（上游、认证引用、模型映射、优先级、权重、编辑和启停）以及虚拟 API Key（模型权限、RPM、TPM、Token 配额、编辑、启停和撤销）。新 Key 的完整 secret 只在创建成功时显示一次。控制台默认连接当前托管实例；如果配置了 `PROXY_API_KEY` 或启用了虚拟 API Key，在设置页输入可用的 Key 即可。也可以通过 `GATEWAY_URL` 指定其他网关地址。页面使用同源 `fetch` 访问网关，不需要额外安装依赖。

网关不会启动 mitmproxy，也不会启动桌面客户端。之后可以关闭 MiMo、WorkBuddy 和 mitmweb。

`desktop` 模式的生命周期由入口进程管理：退出桌面进程会自动结束托管的 Gateway 子进程。需要让 Gateway 独立常驻时，请使用 `serve` 模式。

客户端统一配置为：

```text
Base URL: http://127.0.0.1:3000/v1
```

不需要设置 `UPSTREAM_PROVIDER`，也不需要在请求中指定 Provider。

## 自动模型路由

```bash
curl http://127.0.0.1:3000/v1/models
```

模型目录会合并 MiMo 和 WorkBuddy 的模型。模型 ID 唯一时直接使用原始 ID；发生冲突时自动使用：

```text
mimo/model-id
workbuddy/model-id
```

调用示例：

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-pro","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

网关会根据模型目录自动选择 MiMo 或 WorkBuddy，并把冲突模型的前缀去掉后再发送给上游。

### DeepSeek Harness

DeepSeek Harness 的自定义 Provider 表单只保存模型基础信息，思考档位需要写入它的配置文件。对于 WorkBuddy 中的 DeepSeek V4，推荐使用 Chat Completions 协议：

```yaml
llm-pi-ai:
  providers:
    llm-gateway:
      api: openai-completions
      baseURL: http://127.0.0.1:3000/v1
      compat:
        thinkingFormat: deepseek
        supportsReasoningEffort: true
        supportsDeveloperRole: false
      reasoning: high
      models:
        - id: deepseek-v4-flash
          contextWindow: 1000000
          maxTokens: 50000
          reasoningEfforts:
            off:
            low: low
            high: high
            max: max
```

`reasoningEfforts` 的左侧是 Harness 的档位，右侧是发送给网关的 `reasoning_effort` 值；`off` 配合 `thinkingFormat: deepseek` 会发送关闭 thinking 的请求。网关会将 Harness 可能发送的 `developer` 系统消息转换为上游可接受的 `system`，并透传 `reasoning_content`。如果 Harness 版本的模型发现流程丢弃了 `reasoningEfforts`，需要保留上面的模型配置并刷新页面、新建会话；这是 Harness 配置发现层的限制，不是 `/v1/chat/completions` 没有返回 thinking。

如果模型目录暂时不可用，也可以显式使用 `mimo/model-id` 或 `workbuddy/model-id` 路由。

## 认证缓存

缓存按 Provider 独立保存：

```text
.runtime/auth/mimo.json
.runtime/auth/workbuddy.json
```

某个 Provider 返回 `401/403` 时，只会删除该 Provider 的缓存，不影响其他 Provider。

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/health/live
curl -i http://127.0.0.1:3000/health/ready
curl http://127.0.0.1:3000/health/auth
```

`/health/auth` 只返回各 Provider 是否有缓存，不返回敏感请求头。

`/health/live` 只检查进程是否存活，`/health/ready` 同时检查至少一个 Provider 已认证且模型目录可用。`/.well-known/llm-gateway/capabilities` 返回协议能力、认证状态和模型元数据，适合桌面 UI 或其他客户端做能力发现。

## 网关配置

网关只需要少量通用变量：

```bash
PORT=3000
BIND_HOST=127.0.0.1
PROXY_API_KEY=change-me
PROXY_ADMIN_KEY=admin-change-me
RUNTIME_DIR=./.runtime
AUTH_CACHE_DIR=./.runtime/auth
MODEL_CACHE_DIR=./.runtime/models
WORKBUDDY_MODEL_FILE= # 可选：覆盖 WorkBuddy 本地模型目录文件
MODEL_DISCOVERY=true
MODEL_DISCOVERY_TIMEOUT_MS=30000
METRICS_MAX_RECORDS=2000
REQUEST_TIMEOUT_MS=180000
RESPONSE_STORE_MAX_ENTRIES=128
RESPONSE_STORE_TTL_MS=3600000
RESPONSE_STORE_MAX_BYTES=8388608
CHANNELS_FILE=./.runtime/channels.json
API_KEYS_FILE=./.runtime/api-keys.json
METRICS_FILE=./.runtime/metrics.json
```

默认只允许同源访问；需要跨域时显式设置 `CORS_ORIGIN`。生产部署建议同时配置 `PROXY_ADMIN_KEY`，并将 `BIND_HOST` 保持为可信网卡地址。

认证工具的 mitmproxy 和客户端参数见 [.env.example](./.env.example)，这些参数不会被网关进程使用。

## HTTP 接口

```text
GET  /
GET  /health
GET  /ui
GET  /ui/
GET  /health/live
GET  /health/ready
GET  /health/auth
GET  /.well-known/llm-gateway/capabilities
GET  /v1/models
GET  /metrics/summary
GET  /metrics/timeseries
GET  /metrics/requests
GET  /metrics/models
GET  /admin/channels
POST /admin/channels
DELETE /admin/channels/:id
GET  /admin/keys
POST /admin/keys
PATCH /admin/keys/:id
DELETE /admin/keys/:id
GET  /admin/metrics/summary
GET  /admin/metrics/timeseries
GET  /admin/metrics/requests
GET  /admin/metrics/models
POST /v1/chat/completions
POST /v1/responses
```

`/metrics/summary`、`/metrics/timeseries` 和 `/metrics/requests` 支持 `window`、`provider`、`model`、`status` 筛选；请求列表额外支持 `limit` 和 `offset` 分页参数。管理员凭证访问控制台时，统计页会自动使用 `/admin/metrics` 查看未按虚拟 API Key 限制的完整数据。

公开协议路由统一使用 `/v1` 前缀，不保留无前缀别名。

网关始终以流式方式请求上游；客户端使用 `stream: false` 时由网关聚合为普通 JSON，同时保留工具调用、思维内容和 usage（若上游提供）。

网关会保留最近 `METRICS_MAX_RECORDS` 条请求元数据，并默认持久化到 `METRICS_FILE`，用于控制面板统计请求数、成功率、延迟和 Token 用量。统计不保存 Prompt、Cookie 或完整响应；删除该文件或修改 `METRICS_FILE` 即可开始新的统计周期。Token 优先使用上游返回的 usage，未返回时显示为未知，不进行伪精确估算。请求在鉴权、参数校验、模型路由阶段失败时也会记录为 `gateway` 错误。

## Channel 与虚拟 API Key

默认会为每个内置 Provider 创建一个 Channel：

```text
.runtime/channels.json
.runtime/auth/mimo.json
.runtime/auth/workbuddy.json
```

Channel 可以配置独立认证缓存、上游地址、模型映射、优先级和权重。相同 Provider 的多个 Channel 会先按优先级选择，再按权重轮询；上游在首个响应块之前返回可重试的 429、5xx 或网络错误时，网关会自动尝试下一个 Channel。所有尝试共享一个总请求超时，流式响应已经开始输出后不会切换上游。

创建一个模型别名和备用渠道：

```bash
curl -X POST http://127.0.0.1:3000/admin/channels \
  -H 'Content-Type: application/json' \
  -d '{"id":"mimo-secondary","name":"MiMo Secondary","providerId":"mimo","authRef":"mimo-secondary","priority":50,"weight":1,"modelMappings":{"fast-chat":"mimo-x-pro-preview"}}'

npm run auth -- --provider mimo --channel mimo-secondary
```

创建虚拟 API Key。响应中的 `secret` 只返回一次；后续仅保存 Hash 和脱敏前缀：

```bash
curl -X POST http://127.0.0.1:3000/admin/keys \
  -H 'Content-Type: application/json' \
  -d '{"name":"local-harness","allowedModels":["deepseek-v4-flash"],"rpmLimit":60,"tpmLimit":100000,"quotaTokens":1000000}'
```

管理接口使用 `PROXY_ADMIN_KEY` 保护；未配置管理员 Key 时，默认仅适合绑定 `127.0.0.1` 的本地管理。启用虚拟 Key 后，客户端使用返回的 `secret` 作为 `Authorization: Bearer <key>`。`PROXY_API_KEY` 仍可作为部署级固定 Key 使用。

网关不会伪装未实现的协议能力：Chat Completions 当前明确限制 `n=1`，Responses 对 `background`、`conversation`、`include`、`max_tool_calls`、`prompt`、`service_tier` 和 `stream_options` 等未实现字段返回 400；不支持 Chat 的音频、图片模型也会在目录中标记，并拒绝被当作对话模型调用。

Chat Completions 流式请求支持标准 `stream_options.include_usage`：网关会在 `[DONE]` 前输出 `choices: []` 的最终 usage chunk，并完整合并 `tool_calls`（包括 `index`、函数名和分片 `function.arguments`）。

工具调用历史在转发前会统一为 `tool_calls` / `tool` 消息，并校验每个工具调用是否有且只有一个匹配的 `tool_call_id` 结果；缺失、重复、孤立或 ID 不匹配的历史会由网关直接返回 400，不再交给上游返回模糊错误。Chat 请求只接受这套标准工具消息格式。

Responses API 会将 `input`、`instructions` 和 Responses 风格的 function tools 适配为上游所需的 Chat Completions 请求，并返回标准 `response` 对象。`stream: true` 时输出标准 Responses SSE 事件，包含 `response.reasoning_text.delta/done`、文本、拒答和函数调用的增量/完成事件（如 `response.function_call_arguments.delta/done`）。`text.format` 会转换为上游的结构化输出参数；Responses 默认保留在受限的进程内会话存储中，支持 `previous_response_id` 链接，并按 TTL、条目数和总字节数淘汰；设置 `response.store=false` 可禁用保存。

调用示例：

```bash
curl http://127.0.0.1:3000/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-pro","input":"你好","stream":false}'
```

## 扩展 Provider

新增客户端时，在 [`src/providers/contracts.ts`](./src/providers/contracts.ts) 遵循 `ProviderAdapter` 契约，在 [`src/providers/builtins.ts`](./src/providers/builtins.ts) 注册实现；通用 OpenAI 兼容传输由 `openai-compatible.ts` 提供，特殊模型发现逻辑通过可选的 `discoverModels` 注入。模型目录、认证缓存、路由、SSE 和 OpenAI 转换逻辑无需复制。
