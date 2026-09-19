import { AlertCircle } from "lucide-react";
import { useState } from "react";
import type { DesktopService } from "../lib/desktop-service";
import { Button, ConfirmDialog, Spinner } from "./ui";

export function ServiceBanner({ service }: { service: DesktopService }) {
  const [confirmForce, setConfirmForce] = useState(false);
  if (!service.native || (service.status?.phase === "running" && !service.error)) return null;
  const { status } = service;
  const pending = !status || status.phase === "starting" || status.phase === "stopping";
  const message =
    service.error ||
    status?.error ||
    (status?.phase === "stopping"
      ? `正在停止服务，等待 ${status.activeRequests} 个请求完成。`
      : status?.phase === "stopped"
        ? "本机网关已停止，可在此处或托盘中重新启动。"
        : status?.phase === "failed"
          ? "本机网关启动或运行失败，请检查监听设置后重试。"
          : "正在启动本机网关…");
  return (
    <div
      role={service.error || status?.error ? "alert" : "status"}
      className="mb-5 rounded-lg border border-warning/20 bg-warning/5 p-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          {pending && !service.error ? (
            <Spinner />
          ) : (
            <AlertCircle className="size-4 shrink-0 text-warning" />
          )}
          {message}
        </span>
        {service.error ? (
          <Button size="sm" variant="outline" onClick={service.retry}>
            重新连接
          </Button>
        ) : status && ["stopped", "failed"].includes(status.phase) ? (
          <Button size="sm" disabled={service.busy} onClick={() => void service.control("start")}>
            启动服务
          </Button>
        ) : null}
      </div>
      {status?.canForceExit && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <span className="text-muted-foreground">
            等待已超过 15 秒。可以继续等待，或强制退出并中断未完成的请求。
          </span>
          <Button size="sm" variant="destructive" onClick={() => setConfirmForce(true)}>
            强制退出
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmForce && Boolean(status?.canForceExit)}
        title="强制退出 LLM Gateway？"
        description="尚未完成的请求将被中断。客户端可能需要重新发送请求。"
        confirmLabel="中断请求并退出"
        destructive
        onCancel={() => setConfirmForce(false)}
        onConfirm={() => void service.force()}
      />
    </div>
  );
}
