# LLM Gateway Sync Worker

这个 Worker 只保存客户端加密后的认证包，不保存 MiMo/WorkBuddy 的明文 Cookie 或 Authorization。

## 部署

```bash
cd cloudflare/sync-worker
npm install
npx wrangler secret put SYNC_TOKEN
npm run deploy
```

健康检查：

```bash
curl https://<worker-domain>/health
```

同步接口：

```text
GET    /v1/vault/{vaultId}
PUT    /v1/vault/{vaultId}
DELETE /v1/vault/{vaultId}
```

`PUT` 默认需要携带上一版本的 `If-Match`。首次接管已有保险库或确认覆盖时，客户端可以发送 `X-Sync-Force: 1`。
