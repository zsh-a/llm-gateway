# OpenAI Gateway

一个用 TypeScript 编写、由 Perry 编译核心服务的统一 OpenAI 兼容网关。
当前内置 MiMo 和 WorkBuddy 两个 Provider，客户端只需要配置一次网关地址，模型会自动路由到对应上游。

认证流程与网关运行时完全分离：`npm run auth` 负责首次捕获并缓存认证，`npm run launch` 只运行轻量网关。

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
网关（Perry 原生服务）
  OpenAI Client → ModelCatalog → Provider → LLM 上游
```

核心代码：

```text
src/config.ts       轻量网关配置
src/provider.ts     Provider 注册表、默认上游和统一传输
src/auth-store.ts   网关只读/失效认证缓存
src/models.ts       多 Provider 模型聚合和自动路由
src/sse.ts          SSE/JSON 流解析器
src/openai.ts       OpenAI 请求/响应适配
src/server.ts       OpenAI 兼容 HTTP 服务
src/cli.ts          命令行客户端
src/cdp.ts          MiMo CLI 的浏览器回退通道
scripts/auth.ts     一次性认证引导工具
```

网关进程不导入 `child_process`、mitmproxy 控制逻辑或桌面客户端启动逻辑。

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
dist/mimo-server
dist/mimo-chat
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

## 启动网关

认证完成后直接启动：

```bash
npm run launch
```

网关不会启动 mitmproxy，也不会启动桌面客户端。之后可以关闭 MiMo、WorkBuddy 和 mitmweb。

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
GET  /health
GET  /health/auth
GET  /v1/models
POST /v1/chat/completions
POST /chat/completions
```

网关始终以流式方式请求上游；客户端使用 `stream: false` 时由网关聚合为普通 JSON，同时保留工具调用、思维内容和 usage（若上游提供）。

## 扩展 Provider

新增客户端时，在 [`src/provider.ts`](./src/provider.ts) 注册一个 `ProviderAdapter`，提供默认上游、认证匹配规则和模型源即可。模型目录、认证缓存、路由、SSE 和 OpenAI 转换逻辑无需复制。
