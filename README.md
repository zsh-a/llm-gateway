# MiMo Proxy

一个用 TypeScript 编写、面向 Perry 原生编译的 Xiaomi MiMo OpenAI 兼容桥接器。

项目只负责三件事：复用已有登录态、请求 MiMo 上游接口、在 MiMo SSE 与 OpenAI 响应格式之间做适配。

## 结构

```text
  src/
    config.ts   配置、模型和思考强度
    auth.ts     可扩展凭证提供者、缓存和认证诊断
    models.ts   远程模型发现、缓存和 fallback
    sse.ts      可复用的 SSE/JSON 流解析器
    mimo.ts     MiMo 上游请求与超时控制
    openai.ts   OpenAI 请求/响应适配器
    server.ts   OpenAI 兼容 HTTP 服务
    cli.ts      命令行客户端
    cdp.ts      Chrome CDP 回退通道
  scripts/
    launch.ts         统一启动 mitmweb、服务端和可选客户端
    build-native.mjs 发现 Perry 源码并执行原生编译
```

## 安装与构建

先安装依赖。Perry 编译器会作为项目开发依赖安装：

```bash
npm install
```

当前 Perry 的原生 npm 发布包可能不包含 `node:http`/网络扩展的构建库。`npm run build` 会自动查找项目旁边的 `../perry` 以及临时 Perry 工作区；如果仍未找到，请准备与 `package.json` 中 Perry 版本一致的 Perry 源码工作区：

```bash
git clone --depth 1 --branch v0.5.1520 https://github.com/PerryTS/perry.git ../perry
export PERRY_WORKSPACE_ROOT="$PWD/../perry"
```

检查类型并生成原生服务、CLI 以及 Node 进程编排器：

```bash
npm run typecheck
npm run build
```

产物为：

```text
dist/mimo-server
dist/mimo-chat
dist/scripts/launch.js
```

启动代理：

```bash
./dist/mimo-server
```

一键启动统一运行环境（自动启动 mitmweb 和服务端）：

```bash
npm run launch
```

如果希望同时启动 Xiaomi MiMo Desktop：

```bash
npm run launch:desktop
```

启动器会把客户端指向 `127.0.0.1:8080`，并通过 `127.0.0.1:8081/flows` 复用客户端产生的登录态。进程编排使用标准 Node.js `child_process`，服务核心仍由 TypeScript/Perry 原生编译；这样可以避免 Perry 当前版本原生进程扩展在 macOS 上的运行时崩溃。客户端路径可通过 `MIMO_CLIENT_BIN` 替换，其他支持 Electron/Chromium 代理参数的客户端也可以复用同一套入口。

运行 CLI：

```bash
./dist/mimo-chat "解释一下 SSE 的工作原理" mimo-x-pro-preview high
```

也可以使用：

```bash
npm start
npm run cli -- "你好"
```

## 认证方式

认证优先级为：

```text
MIMO_COOKIE
→ MIMO_COOKIE_FILE / ./cookie.txt
→ mitmproxy /flows 中最近一次成功的 MiMo 请求
```

`MIMO_AUTH_MODE` 可以设为 `cookie`、`mitm` 或 `auto`。首次从 mitmproxy 获取到认证后，会持久化到 `./.runtime/auth.json`，后续重启服务也能直接复用，不必再次启动 MiMo Desktop。收到上游 `401/403` 后会自动删除缓存，下一个请求重新获取。缓存文件只保存认证相关请求头，并尝试设置为仅当前用户可读写；如需退出登录，可手动删除该文件。`GET /health/auth` 只返回认证来源和各提供者状态，不返回敏感请求头。

`GET /v1/models` 默认请求 MiMo Desktop 的 `/api/model/list`，解析 `data.models` 后动态返回；请求失败时依次回退到 `.runtime/models.json` 和内置默认列表。也可以通过 `MIMO_MODEL_LIST_URL` 指向官方 OpenAI 兼容的 `/v1/models` 接口，并用 `MIMO_MODEL_API_KEY` 提供官方 API Key。

mitmproxy 的匹配规则默认使用 MiMo 上游域名和 `/api/route/chat/completions` 路径。可以通过 `MIMO_AUTH_HOSTS`、`MIMO_AUTH_PATHS` 配置多个相似客户端或上游。

CLI 在以上方式不可用或直连失败时，会尝试连接 `CDP_JSON_URL` 指向的 Chrome 页面，并调用网页中的 `window.mimo` 接口。该页面必须已经登录 MiMo，并以远程调试模式启动。

## HTTP 接口

```text
GET  /health
GET  /health/auth
GET  /v1/models
POST /v1/chat/completions
POST /chat/completions
```

服务端始终以流式方式请求上游；客户端传入 `stream: true` 时返回 SSE，传入 `stream: false` 时聚合后返回普通 JSON。

默认只监听 `127.0.0.1`。如需局域网访问，显式设置 `BIND_HOST`，并建议同时设置 `MIMO_PROXY_API_KEY`。
