import { CopyButton } from "./common";

export function ApiExample({ baseUrl }: { baseUrl: string }) {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`.replaceAll("'", "'\\''");
  const example = [
    `curl '${endpoint}'`,
    '  -H "Authorization: Bearer $GATEWAY_API_KEY"',
    "  -H 'Content-Type: application/json'",
    `  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"你好"}],"stream":true}'`,
  ].join(" \\\n");
  return (
    <details className="rounded-lg border p-3 text-sm">
      <summary className="cursor-pointer font-medium">调用示例</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs leading-5 text-muted-foreground">
          将密钥设为 GATEWAY_API_KEY 环境变量，并将 MODEL_ID 替换为工作台中可用的模型 ID。
        </p>
        <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 text-xs leading-6">
          <code>{example}</code>
        </pre>
        <CopyButton value={example} label="复制调用示例" />
      </div>
    </details>
  );
}
