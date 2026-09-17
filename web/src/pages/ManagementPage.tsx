import {
  AlertCircle,
  Check,
  Copy,
  KeyRound,
  Network,
  Pencil,
  Plus,
  Power,
  Save,
  Trash2,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import type { GatewayApi } from "../api";
import { EmptyState, Field, StatusBadge } from "../components/common";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Input,
  Select,
  Spinner,
  Textarea,
} from "../components/ui";
import { formatCompact } from "../lib/format";
import { cn } from "../lib/utils";
import type { ApiKeyRecord, ChannelConfig, DashboardData, Navigate, NoticeTone } from "../types";

interface ChannelDraft {
  id: string;
  name: string;
  providerId: string;
  authRef: string;
  upstreamUrl: string;
  priority: string;
  weight: string;
  modelMappings: string;
}

interface KeyDraft {
  name: string;
  allowedModels: string;
  rpmLimit: string;
  tpmLimit: string;
  quotaTokens: string;
}

type SavingForm = "channel" | "key" | null;

type Confirmation = { kind: "channel"; item: ChannelConfig } | { kind: "key"; item: ApiKeyRecord };

const initialChannel: ChannelDraft = {
  id: "",
  name: "",
  providerId: "",
  authRef: "",
  upstreamUrl: "",
  priority: "100",
  weight: "1",
  modelMappings: "",
};

const initialKey: KeyDraft = {
  name: "",
  allowedModels: "",
  rpmLimit: "",
  tpmLimit: "",
  quotaTokens: "",
};

function channelDraftFrom(item: ChannelConfig): ChannelDraft {
  return {
    id: item.id,
    name: item.name ?? "",
    providerId: item.providerId,
    authRef: item.authRef,
    upstreamUrl: item.upstreamUrl ?? "",
    priority: String(item.priority ?? 100),
    weight: String(item.weight ?? 1),
    modelMappings: item.modelMappings ? JSON.stringify(item.modelMappings, null, 2) : "",
  };
}

function keyDraftFrom(item: ApiKeyRecord): KeyDraft {
  return {
    name: item.name,
    allowedModels: item.allowedModels.join(", "),
    rpmLimit: item.rpmLimit === null ? "" : String(item.rpmLimit),
    tpmLimit: item.tpmLimit === null ? "" : String(item.tpmLimit),
    quotaTokens: item.quotaTokens === null ? "" : String(item.quotaTokens),
  };
}

function optionalInteger(value: string, minimum: number): number | undefined | null {
  if (!value.trim()) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) return null;
  return number;
}

function parseMappings(value: string): Record<string, string> | undefined | null {
  if (!value.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed);
    if (
      entries.some(([key, mapped]) => !key.trim() || typeof mapped !== "string" || !mapped.trim())
    ) {
      return null;
    }
    return Object.fromEntries(entries.map(([key, mapped]) => [key.trim(), mapped.trim()]));
  } catch {
    return null;
  }
}

export function ManagementPage({
  data,
  api,
  onRefresh,
  onNotice,
  onNavigate,
}: {
  data: DashboardData;
  api: GatewayApi;
  onRefresh: () => void;
  onNotice: (message: string, tone?: NoticeTone) => void;
  onNavigate: Navigate;
}) {
  const [channel, setChannel] = useState<ChannelDraft>(initialChannel);
  const [key, setKey] = useState<KeyDraft>(initialKey);
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [copyState, setCopyState] = useState(false);
  const [saving, setSaving] = useState<SavingForm>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const providerOptions = Array.from(
    new Set([...(data.health.providers ?? []), ...Object.keys(data.auth.providers)]),
  );

  const updateChannel = (name: keyof ChannelDraft, value: string): void => {
    setChannel((current) => ({ ...current, [name]: value }));
  };

  const updateKey = (name: keyof KeyDraft, value: string): void => {
    setKey((current) => ({ ...current, [name]: value }));
  };

  const resetChannel = (): void => {
    setChannel({ ...initialChannel });
    setEditingChannelId(null);
  };

  const resetKey = (): void => {
    setKey({ ...initialKey });
    setEditingKeyId(null);
  };

  const saveChannel = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!channel.id.trim() || !channel.providerId || !channel.authRef.trim()) {
      onNotice("渠道 ID、Provider 和认证引用不能为空", "error");
      return;
    }
    const priority = optionalInteger(channel.priority, 0);
    const weight = optionalInteger(channel.weight, 1);
    if (priority === null) {
      onNotice("优先级必须是大于等于 0 的整数", "error");
      return;
    }
    if (weight === null) {
      onNotice("权重必须是大于等于 1 的整数", "error");
      return;
    }
    if (channel.upstreamUrl.trim()) {
      try {
        const url = new URL(channel.upstreamUrl.trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
      } catch {
        onNotice("上游 URL 必须是有效的 http 或 https 地址", "error");
        return;
      }
    }
    const modelMappings = parseMappings(channel.modelMappings);
    if (modelMappings === null) {
      onNotice("模型映射必须是键和值均为字符串的合法 JSON 对象", "error");
      return;
    }

    setSaving("channel");
    try {
      const existing = data.channels.find((item) => item.id === editingChannelId);
      await api.saveChannel({
        id: channel.id.trim(),
        name: channel.name.trim() || channel.id.trim(),
        providerId: channel.providerId,
        authRef: channel.authRef.trim(),
        upstreamUrl: channel.upstreamUrl.trim() || undefined,
        enabled: existing?.enabled !== false,
        priority: priority ?? 100,
        weight: weight ?? 1,
        modelMappings,
      });
      onNotice(editingChannelId ? "渠道已更新" : "渠道已保存");
      resetChannel();
      onRefresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "保存渠道失败", "error");
    } finally {
      setSaving(null);
    }
  };

  const saveKey = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!key.name.trim()) {
      onNotice("请填写 Key 名称", "error");
      return;
    }
    const rpmLimit = optionalInteger(key.rpmLimit, 1);
    const tpmLimit = optionalInteger(key.tpmLimit, 1);
    const quotaTokens = optionalInteger(key.quotaTokens, 1);
    if (rpmLimit === null || tpmLimit === null || quotaTokens === null) {
      onNotice("RPM、TPM 和 Token 配额必须是大于等于 1 的整数", "error");
      return;
    }
    const body = {
      name: key.name.trim(),
      allowedModels: key.allowedModels
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      rpmLimit,
      tpmLimit,
      quotaTokens,
    };

    setSaving("key");
    try {
      if (editingKeyId) {
        await api.updateKey(editingKeyId, body);
        onNotice("Key 已更新");
      } else {
        const created = await api.createKey(body);
        setSecret(created.secret);
        setCopyState(false);
        onNotice("Key 已创建，请立即保存 Secret");
      }
      resetKey();
      onRefresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "保存 Key 失败", "error");
    } finally {
      setSaving(null);
    }
  };

  const editChannel = (item: ChannelConfig): void => {
    setChannel(channelDraftFrom(item));
    setEditingChannelId(item.id);
  };

  const editKey = (item: ApiKeyRecord): void => {
    setKey(keyDraftFrom(item));
    setEditingKeyId(item.id);
    setSecret("");
  };

  const toggleChannel = async (item: ChannelConfig): Promise<void> => {
    const action = `channel-toggle:${item.id}`;
    setPendingAction(action);
    try {
      await api.saveChannel({ ...item, enabled: item.enabled === false });
      onNotice(item.enabled === false ? "渠道已启用" : "渠道已停用");
      onRefresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "更新渠道失败", "error");
    } finally {
      setPendingAction(null);
    }
  };

  const toggleKey = async (item: ApiKeyRecord): Promise<void> => {
    const action = `key-toggle:${item.id}`;
    setPendingAction(action);
    try {
      await api.updateKey(item.id, { enabled: !item.enabled });
      onNotice(item.enabled ? "Key 已停用" : "Key 已启用");
      onRefresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "更新 Key 失败", "error");
    } finally {
      setPendingAction(null);
    }
  };

  const requestRemoveChannel = (item: ChannelConfig): void => {
    setConfirmation({ kind: "channel", item });
  };

  const requestRevokeKey = (item: ApiKeyRecord): void => {
    setConfirmation({ kind: "key", item });
  };

  const confirmRemoval = async (): Promise<void> => {
    if (!confirmation) return;
    const current = confirmation;
    const action = `${current.kind}-remove:${current.item.id}`;
    setPendingAction(action);
    try {
      if (current.kind === "channel") {
        await api.deleteChannel(current.item.id);
        onNotice("渠道已删除");
      } else {
        await api.revokeKey(current.item.id);
        onNotice("Key 已撤销");
      }
      onRefresh();
      setConfirmation(null);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "操作失败", "error");
    } finally {
      setPendingAction(null);
    }
  };

  const copySecret = async (): Promise<void> => {
    if (!secret) return;
    if (!navigator.clipboard) {
      onNotice("当前浏览器不支持一键复制，请手动复制 Secret", "warning");
      return;
    }
    try {
      await navigator.clipboard.writeText(secret);
      setCopyState(true);
      window.setTimeout(() => setCopyState(false), 1600);
    } catch {
      onNotice("复制失败，请手动复制 Secret", "error");
    }
  };

  const actionBusy = (action: string): boolean => pendingAction === action;
  const adminDisabled = Boolean(data.adminError);

  return (
    <div className="space-y-6">
      {data.adminError && (
        <div
          role="alert"
          className={cn(
            "flex flex-wrap items-center justify-between gap-3 rounded-xl",
            "border border-amber-400/20 bg-amber-400/8 p-3 text-sm text-amber-200",
          )}
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {data.adminError}。在设置中保存管理员 API Key 后即可进行写操作。
          </div>
          <Button variant="outline" size="sm" onClick={() => onNavigate("settings")}>
            前往设置
          </Button>
        </div>
      )}
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <ChannelForm
          providers={providerOptions}
          draft={channel}
          saving={saving === "channel"}
          disabled={adminDisabled}
          editing={Boolean(editingChannelId)}
          onChange={updateChannel}
          onCancel={resetChannel}
          onSubmit={saveChannel}
        />
        <KeyForm
          draft={key}
          saving={saving === "key"}
          disabled={adminDisabled}
          editing={Boolean(editingKeyId)}
          secret={secret}
          copyState={copyState}
          onChange={updateKey}
          onCancel={resetKey}
          onSubmit={saveKey}
          onCopy={() => void copySecret()}
        />
      </div>
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <ChannelList
          items={data.channels}
          pendingAction={pendingAction}
          onEdit={editChannel}
          onToggle={(item) => void toggleChannel(item)}
          onRemove={requestRemoveChannel}
          isBusy={actionBusy}
        />
        <ApiKeyList
          items={data.keys}
          pendingAction={pendingAction}
          onEdit={editKey}
          onToggle={(item) => void toggleKey(item)}
          onRevoke={requestRevokeKey}
          isBusy={actionBusy}
        />
      </div>
      <ConfirmDialog
        open={Boolean(confirmation)}
        title={confirmation?.kind === "channel" ? "删除渠道？" : "撤销 API Key？"}
        description={
          confirmation?.kind === "channel"
            ? `确认删除「${confirmation.item.name || confirmation.item.id}」？该操作会立即从路由中移除渠道。`
            : `确认撤销「${confirmation?.item.name ?? "此 Key"}」？使用该凭证的客户端将立即无法调用。`
        }
        confirmLabel={confirmation?.kind === "channel" ? "删除渠道" : "撤销 Key"}
        destructive
        loading={pendingAction?.startsWith(`${confirmation?.kind}-remove:`) ?? false}
        onConfirm={() => void confirmRemoval()}
        onCancel={() => setConfirmation(null)}
      />
    </div>
  );
}

function ChannelForm({
  providers,
  draft,
  saving,
  disabled,
  editing,
  onChange,
  onCancel,
  onSubmit,
}: {
  providers: string[];
  draft: ChannelDraft;
  saving: boolean;
  disabled: boolean;
  editing: boolean;
  onChange: (name: keyof ChannelDraft, value: string) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const providerOptions = Array.from(new Set([...providers, draft.providerId].filter(Boolean)));
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Network className="size-4 text-primary" />
          <CardTitle>{editing ? "编辑渠道" : "新增渠道"}</CardTitle>
        </div>
        <CardDescription>
          {editing
            ? "更新路由参数，已有渠道 ID 不会改变。"
            : "通过 Provider、认证引用和优先级组成统一路由。"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="渠道 ID" htmlFor="channel-id">
              <Input
                id="channel-id"
                required
                value={draft.id}
                onChange={(event) => onChange("id", event.target.value)}
                placeholder="mimo-primary"
                disabled={editing || disabled}
              />
            </Field>
            <Field label="显示名称" htmlFor="channel-name">
              <Input
                id="channel-name"
                value={draft.name}
                onChange={(event) => onChange("name", event.target.value)}
                placeholder="MiMo 主渠道"
                disabled={disabled}
              />
            </Field>
            <Field label="Provider" htmlFor="channel-provider">
              <Select
                id="channel-provider"
                required
                value={draft.providerId}
                onChange={(event) => onChange("providerId", event.target.value)}
                disabled={!providerOptions.length || disabled}
              >
                <option value="">
                  {providerOptions.length ? "选择 Provider" : "暂无可用 Provider"}
                </option>
                {providerOptions.map((provider) => (
                  <option key={provider} value={provider}>
                    {provider}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="认证引用" htmlFor="channel-auth-ref">
              <Input
                id="channel-auth-ref"
                required
                value={draft.authRef}
                onChange={(event) => onChange("authRef", event.target.value)}
                placeholder="mimo"
                disabled={disabled}
              />
            </Field>
            <Field label="优先级" htmlFor="channel-priority">
              <Input
                id="channel-priority"
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={draft.priority}
                onChange={(event) => onChange("priority", event.target.value)}
                placeholder="100"
                disabled={disabled}
              />
            </Field>
            <Field label="权重" htmlFor="channel-weight">
              <Input
                id="channel-weight"
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={draft.weight}
                onChange={(event) => onChange("weight", event.target.value)}
                placeholder="1"
                disabled={disabled}
              />
            </Field>
          </div>
          <Field label="上游 URL（可选）" htmlFor="channel-upstream-url">
            <Input
              id="channel-upstream-url"
              type="url"
              value={draft.upstreamUrl}
              onChange={(event) => onChange("upstreamUrl", event.target.value)}
              placeholder="留空使用 Provider 默认地址"
              disabled={disabled}
            />
          </Field>
          <Field label="模型映射 JSON（可选）" htmlFor="channel-model-mappings">
            <Textarea
              id="channel-model-mappings"
              rows={2}
              spellCheck={false}
              value={draft.modelMappings}
              onChange={(event) => onChange("modelMappings", event.target.value)}
              placeholder={'{"public-model":"upstream-model"}'}
              className="min-h-20 font-mono text-xs"
              disabled={disabled}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving || disabled}>
              {saving ? <Spinner className="size-3.5" /> : <Save className="size-4" />}
              {saving ? "保存中..." : editing ? "更新渠道" : "保存渠道"}
            </Button>
            {editing && (
              <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
                取消编辑
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function KeyForm({
  draft,
  saving,
  disabled,
  editing,
  secret,
  copyState,
  onChange,
  onCancel,
  onSubmit,
  onCopy,
}: {
  draft: KeyDraft;
  saving: boolean;
  disabled: boolean;
  editing: boolean;
  secret: string;
  copyState: boolean;
  onChange: (name: keyof KeyDraft, value: string) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCopy: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-cyan-300" />
          <CardTitle>{editing ? "编辑访问 Key" : "创建访问 Key"}</CardTitle>
        </div>
        <CardDescription>
          {editing
            ? "调整名称、模型权限和限额，不会重新生成 Secret。"
            : "为不同客户端分配独立凭证和访问限额。"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <Field label="Key 名称" htmlFor="key-name">
            <Input
              id="key-name"
              required
              value={draft.name}
              onChange={(event) => onChange("name", event.target.value)}
              placeholder="local-client"
              disabled={disabled}
            />
          </Field>
          <Field label="允许模型" htmlFor="key-allowed-models">
            <Input
              id="key-allowed-models"
              value={draft.allowedModels}
              onChange={(event) => onChange("allowedModels", event.target.value)}
              placeholder="留空表示全部模型，多个模型用逗号分隔"
              disabled={disabled}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="RPM" htmlFor="key-rpm">
              <Input
                id="key-rpm"
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={draft.rpmLimit}
                onChange={(event) => onChange("rpmLimit", event.target.value)}
                placeholder="不限"
                disabled={disabled}
              />
            </Field>
            <Field label="TPM" htmlFor="key-tpm">
              <Input
                id="key-tpm"
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={draft.tpmLimit}
                onChange={(event) => onChange("tpmLimit", event.target.value)}
                placeholder="不限"
                disabled={disabled}
              />
            </Field>
            <Field label="Token 配额" htmlFor="key-quota">
              <Input
                id="key-quota"
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={draft.quotaTokens}
                onChange={(event) => onChange("quotaTokens", event.target.value)}
                placeholder="不限"
                disabled={disabled}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving || disabled}>
              {saving ? (
                <Spinner className="size-3.5" />
              ) : editing ? (
                <Save className="size-4" />
              ) : (
                <Plus className="size-4" />
              )}
              {saving ? "保存中..." : editing ? "更新 Key" : "创建 Key"}
            </Button>
            {editing && (
              <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
                取消编辑
              </Button>
            )}
          </div>
        </form>
        {secret && (
          <div className="mt-5 rounded-xl border border-emerald-400/25 bg-emerald-400/10 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-medium text-emerald-200">
                Secret 只显示这一次，请立即保存
              </div>
              <Button variant="ghost" size="sm" onClick={onCopy}>
                {copyState ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copyState ? "已复制" : "复制"}
              </Button>
            </div>
            <code className="block break-all rounded-lg bg-black/15 p-2 font-mono text-xs text-emerald-100">
              {secret}
            </code>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ChannelList({
  items,
  pendingAction,
  onEdit,
  onToggle,
  onRemove,
  isBusy,
}: {
  items: ChannelConfig[];
  pendingAction: string | null;
  onEdit: (item: ChannelConfig) => void;
  onToggle: (item: ChannelConfig) => void;
  onRemove: (item: ChannelConfig) => void;
  isBusy: (action: string) => boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>渠道列表</CardTitle>
        <CardDescription>{items.length} 个已配置渠道</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 && <EmptyState icon={Network} title="暂无渠道" />}
        {items.map((item) => {
          const toggleAction = `channel-toggle:${item.id}`;
          const removeAction = `channel-remove:${item.id}`;
          const busy = Boolean(pendingAction);
          return (
            <div
              key={item.id}
              className={cn(
                "flex items-center justify-between gap-3 rounded-xl",
                "border border-border/70 bg-muted/15 px-3.5 py-3",
              )}
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Network className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{item.name || item.id}</div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {item.id} · {item.providerId} · {item.authRef}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <StatusBadge
                  status={item.enabled === false ? "offline" : "ready"}
                  label={item.enabled === false ? "停用" : "启用"}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onEdit(item)}
                  disabled={busy}
                  title="编辑渠道"
                  aria-label="编辑渠道"
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onToggle(item)}
                  disabled={busy}
                  title={item.enabled === false ? "启用渠道" : "停用渠道"}
                  aria-label={item.enabled === false ? "启用渠道" : "停用渠道"}
                >
                  {isBusy(toggleAction) ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <Power className="size-3.5" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemove(item)}
                  disabled={busy}
                  title="删除渠道"
                  aria-label="删除渠道"
                >
                  {isBusy(removeAction) ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <Trash2 className="size-3.5 text-red-300" />
                  )}
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function ApiKeyList({
  items,
  pendingAction,
  onEdit,
  onToggle,
  onRevoke,
  isBusy,
}: {
  items: ApiKeyRecord[];
  pendingAction: string | null;
  onEdit: (item: ApiKeyRecord) => void;
  onToggle: (item: ApiKeyRecord) => void;
  onRevoke: (item: ApiKeyRecord) => void;
  isBusy: (action: string) => boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>虚拟 API Keys</CardTitle>
        <CardDescription>{items.length} 个已管理密钥</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 && <EmptyState icon={KeyRound} title="暂无虚拟 Key" />}
        {items.map((item) => {
          const toggleAction = `key-toggle:${item.id}`;
          const removeAction = `key-remove:${item.id}`;
          const limits = [
            item.rpmLimit === null ? "RPM 不限" : `RPM ${item.rpmLimit}`,
            item.tpmLimit === null ? "TPM 不限" : `TPM ${formatCompact(item.tpmLimit)}`,
          ].join(" · ");
          const busy = Boolean(pendingAction);
          return (
            <div
              key={item.id}
              className={cn(
                "flex items-center justify-between gap-3 rounded-xl",
                "border border-border/70 bg-muted/15 px-3.5 py-3",
              )}
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-300">
                  <KeyRound className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{item.name}</div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {item.prefix}… · 已用 {formatCompact(item.usedTokens)} tokens
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{limits}</div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {item.enabled ? (
                  <Badge variant="success">启用</Badge>
                ) : (
                  <Badge variant="muted">已停用</Badge>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onEdit(item)}
                  disabled={busy}
                  title="编辑 Key"
                  aria-label="编辑 Key"
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onToggle(item)}
                  disabled={busy}
                  title={item.enabled ? "停用 Key" : "启用 Key"}
                  aria-label={item.enabled ? "停用 Key" : "启用 Key"}
                >
                  {isBusy(toggleAction) ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <Power className="size-3.5" />
                  )}
                </Button>
                {item.enabled && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onRevoke(item)}
                    disabled={busy}
                    title="撤销 Key"
                    aria-label="撤销 Key"
                  >
                    {isBusy(removeAction) ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <Trash2 className="size-3.5 text-red-300" />
                    )}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
