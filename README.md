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
src-tauri/src/gateway/ Rust 网关：HTTP/桌面管理适配、认证策略、路由、协议和模型目录
src-tauri/src/db/      渠道初始化、准入限流和持久化用量
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

`AppState` 负责组装依赖；认证策略、渠道选路、模型缓存与请求生命周期分别由独立模块管理。
HTTP 和桌面 IPC 调用同一组管理操作，分别在入口检查管理员凭证和本机窗口权限。
React 根组件维护路由与服务状态，各功能页面组合自己的资源查询，共用 TanStack Query 缓存。

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

尚未包含开机自启开关或日志文件管理。强制终止进程、系统强制关机不保证完成请求排空。

## 应用内更新

- 正式桌面版启动 10 秒后后台检查更新，之后每 24 小时检查一次；网络错误每小时重试，不阻塞启动或认证同步。托盘“检查更新…”和“设置 → 应用更新”可手动检查。
- 点击“下载更新”后由 Rust 后台下载并验证签名，隐藏窗口或切换页面不会取消任务。下载完成后由用户点击“更新并重启”，不会自动中断使用。
- 安装前暂停新模型请求并等待正在进行的请求完整结束。等待期间可“稍后更新，恢复服务”；进入最终服务关闭和安装阶段后不能取消。不会因等待超时自动杀死请求。
- 下载、验签或安装器启动失败会保留重试入口；安装准备失败后恢复原来的服务启停状态。Windows 安装器已启动并退出旧应用后的失败需通过完整安装包恢复，不保证自动回滚。
- 更新重启后保留之前的服务启停状态。认证、配置和数据库继续使用原用户数据目录。已验证的下载保留在当前进程中，完全退出后需要重新下载。
- Windows 分别使用与原安装方式对应的 NSIS EXE / MSI 更新包；macOS 使用 `.app.tar.gz` 更新包。下载页同时保留普通安装包。
- 浏览器控制台和 headless 模式不安装桌面更新。开发模式不自动检查，也不允许执行安装。

`v1.1.2` 及更早版本没有更新器，需要手动安装一次首个包含此功能的版本，之后才能应用内升级。

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

## Key 管理与用量统计

- 桌面控制台通过仅限主窗口的 Tauri 原生命令管理本机网关，不需要填写业务 Key 就能查看所有 Key、模型目录和统计。创建或撤销业务 Key 不会影响管理页面。工作台调用模型仍使用「设置 → 连接与凭证」中的 Gateway Key，调用用量归属于该 Key。
- HTTP 管理接口 `/admin/*` 必须使用独立的 `PROXY_ADMIN_KEY`，包括本机回环访问；不再默认匿名开放，也不再复用 `PROXY_API_KEY`。浏览器控制台的「管理员 Key」填写该凭证。「Gateway Key」用于模型调用及 `/metrics/*` 自己的统计。
- 「统计分析」默认显示管理员有权访问的全部 Key，可按 Key、时间、Provider、模型和请求状态筛选；Key 用量表支持名称搜索、状态过滤和用量排序。点击 Key 查看趋势和请求明细，点击「管理」调整权限与限额。客户端凭证只能访问自己的统计，不能通过 `apiKeyId` 查询其他 Key。
- 请求明细显示 `apiKeyId` / `apiKeyName`；`/admin/metrics/summary` 提供 `keyUsage`、`scope`、`periodStart` 和 `history`。三类统计接口均支持 `apiKeyId` 筛选。撤销 Key 保留名称、累计用量和历史归属，且不可重新启用；需要继续调用时请创建新 Key。
- 用量按分钟汇总，趋势默认按小时展示；时间窗口起点按分钟对齐。汇总和累计配额不受 `METRICS_MAX_RECORDS` 明细保留上限影响。P50/P95 来自延迟直方图，为近似值；平均值和最大值为实际记录值。上游未返回的 Token 用量标记为未知，不按零消耗显示。
- 升级会在事务内迁移现有数据库、补算尚存明细，不重复累计 Key 配额。升级前已清理的明细无法恢复，控制台会注明历史数据的完整起点。明细、汇总和配额在同一事务内更新，并按请求 ID 去重。
- RPM 在模型请求获准进入时原子计数，包含尚未结束的请求；TPM 按请求结束时已知的 Token 用量统计最近 60 秒，长流不会因开始时间较早而漏记。正在生成、尚未结算的 Token 不预估扣减，因此 TPM 和累计配额不是对进行中输出的硬截断。限流记录独立保存在 SQLite，重启和明细清理不重置当前窗口；读取模型和自身用量不会占用推理限额。
- 每台网关独立统计。远端认证同步只同步 Provider 登录凭证，不同步 API Keys、SQLite 数据库或使用情况。

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

标签必须与 `package.json`、npm lock、Cargo package/lock、Tauri 配置中的版本一致。
标签工作流先创建草稿 Release，验证两个平台的所有产物与签名，上传安装包、签名和
`latest.json` 后才公开为 latest。更新清单的下载地址固定到版本标签；已公开的版本不覆盖重发。
构建前清理 bundle 缓存，防止旧安装包进入新 Release。`npm run test:release` 验证清单与签名处理。

更新签名配置：

- Tauri 配置内置更新公钥。GitHub 仓库 Secret `TAURI_SIGNING_PRIVATE_KEY` 保存对应私钥内容；加密私钥可另设 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
- 私钥只能存放在仓库之外并妥善备份；不要提交、写入日志或随安装包分发。不要随意重新生成公钥，否则已有客户端将无法验证后续更新。
- PR 和普通分支构建不需要签名密钥，也不生成更新签名。标签发布缺少密钥或验签失败会停止发布。
- 本地签名打包需设置 `TAURI_SIGNING_PRIVATE_KEY`（私钥文件路径或内容）及密码；仅测试普通安装包可使用 `npm run package:tauri -- --config '{"bundle":{"createUpdaterArtifacts":false}}'`。

当前 macOS 构建使用 ad-hoc 签名，适合测试和内部分发；正式公开分发还需要配置 Apple Developer
证书和公证。Tauri 更新签名与操作系统代码签名是独立的，两者不能相互替代。

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
旧认证包未保存 User-Agent 时会使用 `CLI/5.5.6 WorkBuddy/5.5.6`，包含上游选择模型目录所需的
CLI 平台标识；新捕获的认证会保留客户端完整的原始 User-Agent。
模型请求复用 5 分钟缓存，到期后下次查询会重新获取。成功结果只保存模型元数据到
`RUNTIME_DIR/models/workbuddy.json`；认证失效、网络失败或返回空目录时不会覆盖已有目录。
远程失败后依次尝试显式设置的 `WORKBUDDY_MODEL_FILE` 和网关保存的成功模型目录。
不再自动读取 WorkBuddy 客户端的合并缓存或安装包清单，避免将其中的内置模型作为实际发现结果。
网关不补充任何默认模型；没有可用目录时返回空列表。`MODEL_DISCOVERY=false` 会关闭远程及本地发现，返回空列表。

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
UPSTREAM_CONNECT_TIMEOUT_MS=15000
UPSTREAM_FIRST_BYTE_TIMEOUT_MS=180000
UPSTREAM_IDLE_TIMEOUT_MS=180000
MAX_BODY_BYTES=8388608
MODEL_DISCOVERY=true
MODEL_DISCOVERY_TIMEOUT_MS=30000
METRICS_MAX_RECORDS=2000
# WORKBUDDY_MODEL_FILE=/path/to/workbuddy-models.json
# DEFAULT_MODEL=provider/model-id
# CORS_ORIGIN=https://chat.example.com,http://localhost:5173
```

桌面应用可以在“设置 → 服务监听”中配置 Host、Port 和允许跨域来源（CORS），保存后自动重启并写入
`RUNTIME_DIR/service.json`。环境变量 `BIND_HOST`、`PORT` 和 `CORS_ORIGIN` 优先级更高，适合 headless、容器和
systemd/launchd 服务。debug 模式默认使用项目下的 `.runtime`；release 应用默认使用系统用户数据目录。
macOS 路径为 `~/Library/Application Support/LLM Gateway`。设置 `RUNTIME_DIR` 可以固定到其他目录。

### 上游超时与请求诊断

桌面“设置 → 服务监听”可分别配置连接、首包和数据空闲超时，保存后重启生效：

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | 15000 | DNS、TCP、TLS 等建立连接阶段的上限 |
| `UPSTREAM_FIRST_BYTE_TIMEOUT_MS` | 180000 | 从每次渠道请求开始，到首个非空响应体数据的等待上限；包含连接与等待响应头，收到响应头不会重新计时 |
| `UPSTREAM_IDLE_TIMEOUT_MS` | 180000 | 首个数据之后，每次读取新数据的空闲等待上限，收到数据后重置；SSE 心跳也算数据 |

模型调用没有总时长上限，持续输出的流式请求可超过三分钟。非流式调用也使用同样的分阶段限制，
因为网关从上游读取流后再汇总返回。新的环境变量优先于旧 `REQUEST_TIMEOUT_MS`；旧变量仅作为
首包和空闲等待的回退值，不再限制整个请求的时长。环境变量覆盖桌面保存的值。

请求详情显示错误码、失败阶段、阈值、响应头/首包/最后数据到达时间、收到的字节数和渠道尝试次数。
连接超时为 `upstream_connect_timeout`，未收到首包为 `upstream_first_byte_timeout`，
收到数据后停滞为 `upstream_idle_timeout`；连接拒绝、读取中断和流提前结束分别记录其他错误码。
这些超时在尚未发送响应时返回 HTTP 504；流式 HTTP 200 已发送后，通过 SSE `event: error`
发送相同的错误信息并结束流，不伪造成功完成标记。结果状态码记录为 504，表示处理结果。

诊断与请求明细一起持久化到 SQLite 的 `request_metrics.diagnostics_json`，并由统计接口返回 `diagnostics`。
通过响应头 `x-request-id` 或错误中的 `requestId` 可与详情中的 Request ID 对照；跨域网页也可以读取该响应头。
失败时还会输出带 Request ID、渠道、错误码、阶段和已收数据量的 warning 日志。诊断不会保存提示词、响应内容、
认证头或完整上游 URL。日志仍输出到进程标准输出；桌面没有独立日志文件，排查优先查看持久化的请求详情。
诊断遵循请求明细保留上限；旧版本记录没有这些信息，无法事后还原超时阶段。
中断前已返回的 usage 会保留；“用量未知”只表示缺少 usage，不能证明没有收到输出。

### 从其他网站的网页调用网关

1. 在桌面“设置 → 服务监听 → 允许跨域来源（CORS）”填写网页的来源，例如 `https://chat.example.com`。
   只填写协议、域名和端口，不含页面路径；多个来源用逗号或换行分隔。填 `*` 允许所有网站，留空仅允许桌面端来源。
   自定义来源不会影响桌面端访问。保存后应用会自动重启；headless 可设置 `CORS_ORIGIN`，无效值会记录警告并仅允许桌面端来源。
2. 为该网页创建一个 Gateway Key。在网页的 OpenAI 兼容接口设置中填写 Base URL `http://127.0.0.1:3000/v1`
   （按实际端口调整）以及该 Key。浏览器和网关在同一台机器上时，Host 保持 `127.0.0.1` 即可。
3. 若浏览器提示访问本地网络，请允许该网站访问。该权限由浏览器控制，参见 [Chrome 本地网络访问说明](https://developer.chrome.com/blog/local-network-access)。

模型查询、Chat Completions、Responses 和 SSE 流式输出均支持跨域；OPTIONS 预检无需 Key，实际请求仍进行原有 Key 校验。
可使用 `Authorization: Bearer <Gateway Key>` 或 `x-api-key`，不使用 Cookie 认证。例如：

```js
const response = await fetch("http://127.0.0.1:3000/v1/models", {
  headers: { Authorization: "Bearer YOUR_GATEWAY_KEY" },
  credentials: "omit",
});
if (!response.ok) throw new Error(await response.text());
const models = await response.json();
```

网页需要支持浏览器直接请求；如果请求实际由网站服务器转发，`127.0.0.1` 指向的是网站服务器。
网站自身的 CSP 也必须允许连接网关地址。跨域配置不会授予管理权限，业务 Key 仍只能查看自己的用量。

HTTP 请求体默认上限为 8 MiB（8,388,608 字节），由 `MAX_BODY_BYTES` 控制；它按整个 JSON 的
字节数计算，与模型的 token 上下文限制无关，历史 `reasoning_content` 和 tool 输出也会占用。
Chat Completions / Responses 请求超限时返回 HTTP 413 和 `request_body_too_large`，错误中包含
当前上限；`/.well-known/llm-gateway/capabilities` 的 `limits.maxBodyBytes` 也会返回生效值。
如需调整，请在启动网关的进程环境中设置该变量，然后完全退出并重新启动。仅修改 `.env.example`
不会生效；已设置的环境变量会覆盖默认值。旧版默认 1 MiB 的网关也可通过设置
`MAX_BODY_BYTES=8388608` 提高上限，无需改动模型配置。

SQLite 默认路径为 `RUNTIME_DIR/gateway.sqlite3`。首次初始化渠道时从旧的 `channels.json` 导入；没有旧文件时才创建默认渠道，并持久化初始化标记。删除全部渠道后重启不会重新生成默认渠道，禁用或删除某个 Provider 的全部渠道后，模型请求返回无可用渠道错误。升级保留已有数据库的渠道配置，包括空配置。旧 `api-keys.json` 仍在数据库没有 Key 时导入；后续管理数据以 SQLite 为准。

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

非流式 Chat 与流式诊断共用增量 SSE 解析器，聚合保留多个 choice、工具调用参数和 reasoning；支持跨网络分片的 UTF-8 以及 LF/CRLF/CR 换行。
Responses 的非流式请求会转换为 `response` 对象，保留函数调用的 `call_id`、名称和参数，并支持将函数结果作为后续输入；流式 Responses 当前仍透传上游 Chat SSE，尚未转换成 Responses 事件序列。Chat 的流式指标、usage、超时、客户端断开和渠道重试由 Rust 网关处理。

## 管理渠道和 Key

HTTP 管理 API 无论本地或远程监听都需要独立的 `PROXY_ADMIN_KEY`。桌面控制台通过本机窗口权限直接管理。

```bash
curl -X POST http://127.0.0.1:3000/admin/channels \
  -H 'Authorization: Bearer <PROXY_ADMIN_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{"id":"mimo-secondary","providerId":"mimo","authRef":"mimo-secondary","priority":50}'

curl -X POST http://127.0.0.1:3000/admin/keys \
  -H 'Authorization: Bearer <PROXY_ADMIN_KEY>' \
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
