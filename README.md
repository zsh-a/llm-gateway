# LLM Gateway

一个用 TypeScript 编写、由 Perry 编译核心服务的统一 OpenAI 兼容网关。
当前内置 MiMo 和 WorkBuddy 两个 Provider，客户端只需要配置一次网关地址，模型会自动路由到对应上游。

认证流程与网关运行时完全分离：`npm run auth` 负责首次捕获并缓存认证；网关和桌面控制面板由同一个二进制提供 `serve`、`desktop` 两种模式。

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
同一个 Perry 原生二进制
  serve   → OpenAI Client → ModelCatalog → Provider → LLM 上游
  desktop → 托管 serve 子进程 + Perry UI 控制面板
```

核心代码：

```text
src/config.ts       轻量网关配置
src/provider.ts     Provider 注册表、默认上游和统一传输
src/auth-store.ts   网关只读/失效认证缓存
src/models.ts       多 Provider 模型聚合和自动路由
src/sse.ts          基于 eventsource-parser 的 SSE/JSON 流解析器
src/stream.ts       Provider chunk → StreamEvent 统一中间表示
src/openai.ts       OpenAI 请求/响应适配
src/responses.ts    Responses 输入/输出适配
src/server.ts       OpenAI 兼容 HTTP 服务与启动生命周期
src/dashboard.ts    Perry UI 原生桌面控制面板与启动生命周期
src/main.ts         serve / desktop 模式入口
scripts/auth.ts     一次性认证引导工具
```

`serve` 模式只运行网关，不创建 UI；`desktop` 模式由同一个入口托管 Gateway 子进程和 Perry 原生控制面板。这样构建产物和启动方式统一，同时避开当前 Perry macOS UI 事件循环对 `node:http` 异步 accept 的限制。
认证工具仍然独立，不会被网关或桌面模式自动启动。

## 安装与构建

```bash
npm install
npm run typecheck
npm run build
```

如果 Perry 找不到网络扩展或标准库源码，准备对应版本的 Perry 工作区：

```bash
git clone --depth 1 --branch v0.5.1520 https://github.com/PerryTS/perry.git ../perry
export PERRY_WORKSPACE_ROOT="$PWD/../perry"
npm run build
```

产物：

```text
dist/llm-gateway
dist/scripts/auth.js
```

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
npm run launch
# 等价于：
# ./dist/llm-gateway serve
```

桌面端一键启动 Gateway 和控制面板：

```bash
npm run desktop
# 等价于：
# ./dist/llm-gateway desktop
```

`desktop` 会由同一个二进制托管 Gateway 子进程并打开 Perry 原生窗口，查看网关、Provider、认证和模型状态，并发送真实测试请求。控制面板默认连接当前托管实例的 `http://127.0.0.1:3000`；如果配置了 `PROXY_API_KEY`，在窗口中输入同一个 Key 即可。也可以通过 `GATEWAY_URL` 指定其他网关地址。UI 使用系统 `curl` 异步访问网关，macOS 无需额外安装依赖。

网关不会启动 mitmproxy，也不会启动桌面客户端。之后可以关闭 MiMo、WorkBuddy 和 mitmweb。

`desktop` 模式的生命周期由 UI 入口管理：关闭窗口或退出桌面进程会自动结束托管的 Gateway 子进程。需要让 Gateway 独立常驻时，请使用 `serve` 模式。

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
curl http://127.0.0.1:3000/health/auth
```

`/health/auth` 只返回各 Provider 是否有缓存，不返回敏感请求头。

## 网关配置

网关只需要少量通用变量：

```bash
PORT=3000
BIND_HOST=127.0.0.1
PROXY_API_KEY=change-me
RUNTIME_DIR=./.runtime
AUTH_CACHE_DIR=./.runtime/auth
MODEL_CACHE_DIR=./.runtime/models
MODEL_DISCOVERY=true
```

认证工具的 mitmproxy 和客户端参数见 [.env.example](./.env.example)，这些参数不会被网关进程使用。

## HTTP 接口

```text
GET  /
GET  /health
GET  /health/auth
GET  /v1/models
POST /v1/chat/completions
POST /chat/completions
POST /v1/responses
POST /responses
```

网关始终以流式方式请求上游；客户端使用 `stream: false` 时由网关聚合为普通 JSON，同时保留工具调用、思维内容和 usage（若上游提供）。

Chat Completions 流式请求支持标准 `stream_options.include_usage`：网关会在 `[DONE]` 前输出 `choices: []` 的最终 usage chunk，并完整合并现代 `tool_calls`（包括 `index`、函数名和分片 `function.arguments`）。旧式 `function_call` 会在统一内部流事件层转换为现代工具调用格式。

Responses API 会将 `input`、`instructions` 和 Responses 风格的 function tools 适配为上游所需的 Chat Completions 请求，并返回兼容的 `response` 对象。`stream: true` 时输出标准 Responses SSE 事件，包含 `response.reasoning_text.delta/done`、文本、拒答和函数调用的增量/完成事件（如 `response.function_call_arguments.delta/done`）。`text.format` 会转换为上游的结构化输出参数；`previous_response_id` 支持当前网关进程内的轻量会话链，网关重启后会按无状态服务返回 400，而不是静默丢弃。

调用示例：

```bash
curl http://127.0.0.1:3000/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-pro","input":"你好","stream":false}'
```

## 扩展 Provider

新增客户端时，在 [`src/provider.ts`](./src/provider.ts) 注册一个 `ProviderAdapter`，提供默认上游、认证匹配规则和模型源即可。模型目录、认证缓存、路由、SSE 和 OpenAI 转换逻辑无需复制。
