import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Field, InfoRow } from "../../components/common";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  PasswordInput,
  Spinner,
} from "../../components/ui";
import { formatTime } from "../../lib/format";
import { queryErrorMessage } from "../../lib/query";
import { isTauriRuntime } from "../../platform";
import {
  loadRemoteSyncDraft,
  type RemoteSyncSettings,
  type RemoteSyncStatus,
  remoteSyncPull,
  remoteSyncStatus,
  saveRemoteSyncDraft,
} from "../../remote-sync";
import type { NoticeTone } from "../../types";

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
  const [status, setStatus] = useState<RemoteSyncStatus | null>(null);
  const statusMutation = useMutation({
    mutationFn: remoteSyncStatus,
    onSuccess: (next) => {
      setStatus(next);
      onNotice(
        next.exists ? `远端版本 ${next.revision}` : "远端保险库尚不存在",
        next.exists ? "success" : "warning",
      );
    },
    onError: (error: unknown) => onNotice(queryErrorMessage(error, "远端认证同步失败"), "error"),
  });
  const pullMutation = useMutation({
    mutationFn: ({
      settings,
      passphrase,
      force,
    }: {
      settings: RemoteSyncSettings;
      passphrase: string;
      force: boolean;
    }) => remoteSyncPull(settings, passphrase, force),
    onSuccess: (result) => {
      setStatus({
        vaultId: result.vaultId,
        exists: true,
        revision: result.revision,
        updatedAt: result.updatedAt,
        localRevision: result.revision,
        localProviders: result.providers,
      });
      setPassphrase("");
      const applied = `已拉取并应用 ${result.providers.join("、")} 认证`;
      if (result.workbuddyModelCount) {
        onNotice(`${applied}，已加载 ${result.workbuddyModelCount} 个 WorkBuddy 模型`);
      } else if (result.providers.includes("workbuddy")) {
        onNotice(
          `${applied}；暂未获取到 WorkBuddy 完整模型目录，请检查网络、认证有效性及模型发现设置`,
          "warning",
        );
      } else {
        onNotice(applied);
      }
      onRefresh?.();
    },
    onError: (error: unknown) => onNotice(queryErrorMessage(error, "远端认证同步失败"), "error"),
  });
  const busy = statusMutation.isPending ? "status" : pullMutation.isPending ? "pull" : null;

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
    statusMutation.mutate(settings);
  };

  const pullAuth = async (): Promise<void> => {
    const settings = normalizedSettings();
    if (!settings) return;
    if (passphrase.length < 8) {
      onNotice("同步加密密码至少需要 8 个字符", "error");
      return;
    }
    pullMutation.mutate({ settings, passphrase, force });
  };

  if (!available)
    return (
      <Card>
        <CardHeader>
          <CardTitle>认证同步</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-6 text-muted-foreground">
            请在桌面应用中拉取远端认证。浏览器无法写入本机认证缓存。
          </p>
        </CardContent>
      </Card>
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>远端认证同步</CardTitle>
        <CardDescription>从加密保险库拉取认证，并应用到当前网关。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <Field label="同步服务地址" htmlFor="sync-url">
          <Input
            id="sync-url"
            value={draft.url}
            onChange={(event) => updateDraft("url", event.target.value)}
            placeholder="https://sync.example.com"
            autoComplete="url"
            disabled={busy !== null}
          />
        </Field>
        <Field label="保险库 ID" htmlFor="sync-vault-id">
          <Input
            id="sync-vault-id"
            value={draft.vaultId}
            onChange={(event) => updateDraft("vaultId", event.target.value)}
            placeholder="default"
            disabled={busy !== null}
          />
        </Field>
        <Field label="同步 Token" htmlFor="sync-token">
          <PasswordInput
            id="sync-token"
            value={draft.token}
            onChange={(event) => updateDraft("token", event.target.value)}
            placeholder="输入同步服务的 Token"
            autoComplete="off"
            disabled={busy !== null}
          />
        </Field>
        <Field label="同步密码" htmlFor="sync-passphrase">
          <PasswordInput
            id="sync-passphrase"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            placeholder="至少 8 个字符"
            autoComplete="new-password"
            disabled={busy !== null}
          />
        </Field>
        <p className="text-xs leading-5 text-muted-foreground">
          Token 仅本次会话有效；同步密码不会保存。
        </p>
        <details className="border-t pt-4">
          <summary className="cursor-pointer text-sm text-muted-foreground">高级选项</summary>
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={force}
              onChange={(event) => setForce(event.target.checked)}
              className="mt-1 size-4 accent-primary"
              disabled={busy !== null}
            />
            <span>
              强制覆盖本机认证
              <span className="mt-1 block text-xs text-muted-foreground">
                忽略版本冲突，替换本机缓存。
              </span>
            </span>
          </label>
        </details>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void checkStatus()} disabled={busy !== null}>
            {busy === "status" && <Spinner />}检查远端版本
          </Button>
          <Button onClick={() => void pullAuth()} disabled={busy !== null}>
            {busy === "pull" && <Spinner />}拉取并应用
          </Button>
        </div>
        {status && (
          <div className="space-y-2 border-t pt-4 text-sm">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-medium">同步状态</span>
              <Badge variant={status.exists ? "success" : "warning"}>
                {status.exists ? `远端版本 ${status.revision}` : "保险库不存在"}
              </Badge>
            </div>
            {status.exists && (
              <InfoRow label="远端更新" value={formatTime(status.updatedAt, true)} />
            )}
            <InfoRow
              label="本机版本"
              value={status.localRevision ? String(status.localRevision) : "未同步"}
            />
            <InfoRow label="认证缓存" value={status.localProviders.join("、") || "暂无"} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
