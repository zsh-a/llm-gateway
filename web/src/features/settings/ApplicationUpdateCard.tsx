import type { UpdateStatus } from "../../app-updates";
import { InfoRow } from "../../components/common";
import { Button, Card, CardContent, CardHeader, CardTitle, Spinner } from "../../components/ui";
import type { DesktopUpdates } from "../../lib/desktop-updates";

export const releaseUrl = "https://github.com/zsh-a/llm-gateway/releases/latest";

export function updateMessage(status: UpdateStatus, activeRequests: number): string {
  switch (status.phase) {
    case "checking":
      return "正在检查更新…";
    case "up_to_date":
      return "当前已是最新版本";
    case "available":
      return `发现新版本 v${status.version}`;
    case "downloading":
      return `正在下载 v${status.version}，网关可继续使用`;
    case "ready":
      return `v${status.version} 已下载并通过验证，可更新并重启`;
    case "draining":
      return activeRequests > 0
        ? `正在等待 ${activeRequests} 个请求完成，现有回答不会中断。`
        : "正在完成服务关闭，随后安装更新…";
    case "installing":
      return "正在安装更新，请等待应用重新启动…";
    case "stopping":
      return "正在关闭服务连接，随后安装更新…";
    default:
      return "启动后自动检查更新，也可以手动检查。";
  }
}

export function UpdateActions({ updates }: { updates: DesktopUpdates }) {
  const { status, pending } = updates;
  if (!status) return null;
  if (status.phase === "downloading" || status.phase === "draining")
    return (
      <Button size="sm" variant="outline" onClick={() => void updates.cancel()}>
        {status.phase === "draining" ? "稍后更新，恢复服务" : "取消下载"}
      </Button>
    );
  if (status.phase === "installing" || status.phase === "stopping") return <Spinner />;
  if (status.phase === "ready")
    return (
      <Button size="sm" disabled={pending} onClick={() => void updates.run("install_update")}>
        更新并重启
      </Button>
    );
  if (status.phase === "available")
    return (
      <Button size="sm" disabled={pending} onClick={() => void updates.run("download_update")}>
        {status.error ? "重新下载" : "下载更新"}
      </Button>
    );
  return null;
}

export function UpdateProgress({ status }: { status: UpdateStatus }) {
  if (status.phase !== "downloading") return null;
  const total = status.totalBytes && status.totalBytes > 0 ? status.totalBytes : undefined;
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return (
    <div className="mt-3 space-y-1.5">
      <progress
        className="h-2 w-full accent-primary"
        aria-label="更新下载进度"
        max={total ?? 1}
        value={total ? Math.min(status.downloadedBytes, total) : undefined}
      />
      <p className="text-xs text-muted-foreground">
        {mb(status.downloadedBytes)}
        {total ? ` / ${mb(total)}` : "，正在获取文件大小…"}
      </p>
    </div>
  );
}

export function ApplicationUpdateCard({
  updates,
  activeRequests = 0,
}: {
  updates?: DesktopUpdates;
  activeRequests?: number;
}) {
  const status = updates?.status;
  const busy =
    status &&
    ["checking", "downloading", "draining", "stopping", "installing"].includes(status.phase);
  return (
    <Card>
      <CardHeader>
        <CardTitle>应用更新</CardTitle>
        <p className="text-sm text-muted-foreground">
          下载期间可继续使用。安装前会等待当前请求完成，再重新启动应用。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {!updates?.native ? (
          <p className="text-sm text-muted-foreground">请在桌面应用中检查和安装更新。</p>
        ) : updates.error ? (
          <div role="alert" className="space-y-3 text-sm text-destructive">
            <p>{updates.error}</p>
            <Button size="sm" variant="outline" onClick={updates.retry}>
              重新连接
            </Button>
          </div>
        ) : !status ? (
          <p role="status" className="flex items-center gap-2 text-sm">
            <Spinner />
            正在读取更新状态…
          </p>
        ) : (
          <>
            <div className="space-y-2 text-sm">
              <InfoRow label="当前版本" value={`v${status.currentVersion}`} />
              {status.lastChecked && (
                <InfoRow
                  label="上次检查成功"
                  value={new Date(status.lastChecked).toLocaleString()}
                />
              )}
            </div>
            <div role="status" className="rounded-lg bg-muted/50 p-3 text-sm">
              {updateMessage(status, activeRequests)}
              <UpdateProgress status={status} />
            </div>
            {status.error && (
              <p role="alert" className="text-sm text-destructive">
                {status.error}
              </p>
            )}
            {status.notes && (
              <details className="text-sm" open>
                <summary className="cursor-pointer font-medium">更新内容</summary>
                <p className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
                  {status.notes}
                </p>
              </details>
            )}
            <div className="flex flex-wrap gap-2">
              <UpdateActions updates={updates} />
              {status.phase !== "ready" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={Boolean(busy || updates.pending)}
                  onClick={() => void updates.run("check_for_updates")}
                >
                  {status.phase === "checking" ? "正在检查…" : "检查更新"}
                </Button>
              )}
            </div>
          </>
        )}
        <div className="border-t pt-3 text-xs text-muted-foreground">
          <p className="mb-2">也可以从发布页下载完整安装包。</p>
          <InfoRow label="下载地址" value={releaseUrl} copyable />
        </div>
      </CardContent>
    </Card>
  );
}
