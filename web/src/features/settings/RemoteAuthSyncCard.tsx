import {
  CloudDownload,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { Field, InfoRow } from "../../components/common";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Spinner,
} from "../../components/ui";
import { formatTime } from "../../lib/format";
import {
  isTauriRuntime,
  loadRemoteSyncDraft,
  type RemoteSyncSettings,
  type RemoteSyncStatus,
  remoteSyncPull,
  remoteSyncStatus,
  saveRemoteSyncDraft,
} from "../../remote-sync";
import type { NoticeTone } from "../../types";

function errorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    if (typeof value.message === "string" && value.message.trim()) return value.message;
    if (typeof value.error === "string" && value.error.trim()) return value.error;
    if (value.error && typeof value.error === "object") {
      const nested = value.error as Record<string, unknown>;
      if (typeof nested.message === "string" && nested.message.trim()) return nested.message;
    }
  }
  return "远端认证同步失败";
}

export function RemoteAuthSyncCard({
  onNotice,
  onRefresh,
}: {
  onNotice: (message: string, tone?: NoticeTone) => void;
  onRefresh?: () => void;
}) {
  const available = isTauriRuntime();
  const [draft, setDraft] = useState(loadRemoteSyncDraft);
  const [passphrase, setPassphrase] = useState("");
  const [force, setForce] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [status, setStatus] = useState<RemoteSyncStatus | null>(null);
  const [busy, setBusy] = useState<"status" | "pull" | null>(null);

  const updateDraft = (field: keyof RemoteSyncSettings, value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const normalizedSettings = (): RemoteSyncSettings | null => {
    const settings = {
      url: draft.url.trim().replace(/\/+$/, ""),
      token: draft.token.trim(),
      vaultId: draft.vaultId.trim() || "default",
    };
    if (!settings.url) {
      onNotice("请输入同步服务地址", "error");
      return null;
    }
    if (!/^https?:\/\//i.test(settings.url)) {
      onNotice("同步服务地址必须以 http:// 或 https:// 开头", "error");
      return null;
    }
    if (!settings.token) {
      onNotice("请输入同步 Token", "error");
      return null;
    }
    saveRemoteSyncDraft(settings);
    return settings;
  };

  const checkStatus = async (): Promise<void> => {
    const settings = normalizedSettings();
    if (!settings) return;
    setBusy("status");
    try {
      const next = await remoteSyncStatus(settings);
      setStatus(next);
      onNotice(
        next.exists ? `远端版本 ${next.revision}` : "远端保险库尚不存在",
        next.exists ? "success" : "warning",
      );
    } catch (error) {
      onNotice(errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const pullAuth = async (): Promise<void> => {
    const settings = normalizedSettings();
    if (!settings) return;
    if (passphrase.length < 8) {
      onNotice("同步加密密码至少需要 8 个字符", "error");
      return;
    }
    setBusy("pull");
    try {
      const result = await remoteSyncPull(settings, passphrase, force);
      setStatus({
        vaultId: result.vaultId,
        exists: true,
        revision: result.revision,
        updatedAt: result.updatedAt,
        localRevision: result.revision,
        localProviders: result.providers,
      });
      setPassphrase("");
      onNotice(`已拉取并应用 ${result.providers.join("、")} 认证`);
      onRefresh?.();
    } catch (error) {
      onNotice(errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CloudDownload className="size-4 text-cyan-300" />
          <CardTitle>远端认证同步</CardTitle>
          {available ? (
            <Badge variant="success">桌面端</Badge>
          ) : (
            <Badge variant="muted">仅桌面端</Badge>
          )}
        </div>
        <CardDescription>
          从 Cloudflare 加密保险库拉取 Provider 认证，并立即应用到当前 Gateway。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!available && (
          <div className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2.5 text-xs leading-5 text-amber-200">
            当前页面运行在普通浏览器中。远端认证需要 Tauri 桌面应用执行本地解密和写入。
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="同步服务地址" htmlFor="sync-url">
            <Input
              id="sync-url"
              value={draft.url}
              onChange={(event) => updateDraft("url", event.target.value)}
              placeholder="https://sync.example.com"
              autoComplete="url"
              disabled={!available || busy !== null}
            />
          </Field>
          <Field label="保险库 ID" htmlFor="sync-vault-id">
            <Input
              id="sync-vault-id"
              value={draft.vaultId}
              onChange={(event) => updateDraft("vaultId", event.target.value)}
              placeholder="default"
              autoComplete="off"
              disabled={!available || busy !== null}
            />
          </Field>
        </div>
        <Field label="同步 Token" htmlFor="sync-token">
          <div className="relative">
            <Input
              id="sync-token"
              type={showToken ? "text" : "password"}
              value={draft.token}
              onChange={(event) => updateDraft("token", event.target.value)}
              placeholder="Worker 的 SYNC_TOKEN（不要带 Bearer）"
              className="pr-10"
              autoComplete="off"
              disabled={!available || busy !== null}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1 size-8"
              onClick={() => setShowToken((current) => !current)}
              aria-label={showToken ? "隐藏同步 Token" : "显示同步 Token"}
              title={showToken ? "隐藏" : "显示"}
              disabled={!available}
            >
              {showToken ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </Button>
          </div>
        </Field>
        <Field label="同步加密密码" htmlFor="sync-passphrase">
          <div className="relative">
            <Input
              id="sync-passphrase"
              type={showPassphrase ? "text" : "password"}
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder="至少 8 个字符；不会保存"
              className="pr-10"
              autoComplete="new-password"
              disabled={!available || busy !== null}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1 size-8"
              onClick={() => setShowPassphrase((current) => !current)}
              aria-label={showPassphrase ? "隐藏同步加密密码" : "显示同步加密密码"}
              title={showPassphrase ? "隐藏" : "显示"}
              disabled={!available}
            >
              {showPassphrase ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </Button>
          </div>
        </Field>
        <label className="flex cursor-pointer items-start gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={force}
            onChange={(event) => setForce(event.target.checked)}
            className="mt-0.5 size-3.5 accent-[var(--primary)]"
            disabled={!available || busy !== null}
          />
          <span>
            强制覆盖本机认证缓存
            <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
              关闭时会保留版本冲突保护，避免误覆盖本机凭据。
            </span>
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => void checkStatus()}
            disabled={!available || busy !== null}
          >
            {busy === "status" ? (
              <Spinner className="size-3.5" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            检查远端版本
          </Button>
          <Button onClick={() => void pullAuth()} disabled={!available || busy !== null}>
            {busy === "pull" ? (
              <Spinner className="size-3.5" />
            ) : (
              <CloudDownload className="size-3.5" />
            )}
            拉取并应用
          </Button>
        </div>
        {status && (
          <div className="space-y-2 rounded-xl border border-border/70 bg-muted/15 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-medium text-foreground">同步状态</span>
              <Badge variant={status.exists ? "success" : "warning"}>
                {status.exists ? `远端版本 ${status.revision}` : "远端保险库不存在"}
              </Badge>
            </div>
            {status.exists && (
              <InfoRow label="远端更新时间" value={formatTime(status.updatedAt, true)} />
            )}
            <InfoRow
              label="本机同步版本"
              value={status.localRevision ? String(status.localRevision) : "未同步"}
            />
            <InfoRow
              label="本机认证缓存"
              value={status.localProviders.length ? status.localProviders.join("、") : "暂无"}
            />
          </div>
        )}
      </CardContent>
      <CardFooter className="border-t border-border/60 pt-4 text-[11px] leading-4 text-muted-foreground">
        <ShieldCheck className="mr-1.5 size-3.5 shrink-0 text-emerald-300" />
        <span>
          <KeyRound className="mr-1 inline size-3" />
          Token 仅在当前会话使用，
          <LockKeyhole className="mx-1 inline size-3" />
          加密密码只在同步期间使用，不会持久化。
        </span>
      </CardFooter>
    </Card>
  );
}
