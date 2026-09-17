import {
  AlertCircle,
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  Network,
  Pencil,
  Plus,
  Power,
  Save,
  SlidersHorizontal,
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
} from "../components/ui";
import { formatCompact } from "../lib/format";
import { cn } from "../lib/utils";
import type {
  ApiKeyInput,
  ApiKeyRecord,
  ChannelConfig,
  ChannelInput,
  DashboardData,
  Navigate,
  NoticeTone,
} from "../types";

interface ModelMappingDraft {
  id: string;
  publicModel: string;
  upstreamModel: string;
}

interface ChannelDraft {
  id: string;
  name: string;
  providerId: string;
  authRef: string;
  upstreamUrl: string;
  priority: string;
  weight: string;
  modelMappings: ModelMappingDraft[];
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
  modelMappings: [],
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
    modelMappings: Object.entries(item.modelMappings ?? {}).map(
      ([publicModel, upstreamModel], index) => ({
        id: `${publicModel}-${index}`,
        publicModel,
        upstreamModel,
      }),
    ),
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

function serializeMappings(value: ModelMappingDraft[]): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const mapping of value) {
    const publicModel = mapping.publicModel.trim();
    const upstreamModel = mapping.upstreamModel.trim();
    if (!publicModel && !upstreamModel) continue;
    if (!publicModel || !upstreamModel || Object.hasOwn(result, publicModel)) return null;
    result[publicModel] = upstreamModel;
  }
  return result;
}

function suggestedChannelId(providerId: string, channels: ChannelConfig[]): string {
  const base = `${providerId}-default`;
  if (!channels.some((item) => item.id === base && item.providerId !== providerId)) return base;
  let suffix = 2;
  while (channels.some((item) => item.id === `${providerId}-${suffix}`)) suffix += 1;
  return `${providerId}-${suffix}`;
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
    setChannel((current) => {
      if (name === "providerId") {
        return {
          ...current,
          providerId: value,
          id: editingChannelId ? current.id : value ? suggestedChannelId(value, data.channels) : "",
          name: editingChannelId ? current.name : "",
          authRef: editingChannelId ? current.authRef : "",
        };
      }
      return { ...current, [name]: value };
    });
  };

  const updateKey = (name: keyof KeyDraft, value: string): void => {
    setKey((current) => ({ ...current, [name]: value }));
  };

  const updateChannelMappings = (modelMappings: ModelMappingDraft[]): void => {
    setChannel((current) => ({ ...current, modelMappings }));
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
    if (!channel.id.trim() || !channel.providerId) {
      onNotice("请选择 Provider", "error");
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
    const modelMappings = serializeMappings(channel.modelMappings);
    if (modelMappings === null) {
      onNotice("模型映射需要同时填写公开模型和上游模型，且公开模型不能重复", "error");
      return;
    }

    const id = channel.id.trim();
    const editing = Boolean(editingChannelId);
    const input: ChannelInput = { id, providerId: channel.providerId };
    const name = channel.name.trim();
    const authRef = channel.authRef.trim();
    if (name || editing) input.name = name || id;
    if (authRef || editing) input.authRef = authRef || channel.providerId;
    if (editing) {
      input.enabled = data.channels.find((item) => item.id === editingChannelId)?.enabled !== false;
      input.upstreamUrl = channel.upstreamUrl.trim();
      input.priority = priority ?? 100;
      input.weight = weight ?? 1;
      input.modelMappings = modelMappings;
    } else {
      if (channel.upstreamUrl.trim()) input.upstreamUrl = channel.upstreamUrl.trim();
      if (priority !== undefined && priority !== 100) input.priority = priority;
      if (weight !== undefined && weight !== 1) input.weight = weight;
      if (Object.keys(modelMappings).length > 0) input.modelMappings = modelMappings;
    }

    setSaving("channel");
    try {
      await api.saveChannel(input);
      onNotice(editing ? "渠道已更新" : "渠道已保存");
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
    const body: ApiKeyInput = {
      name: key.name.trim(),
    };
    const allowedModels = key.allowedModels
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (editingKeyId) {
      body.allowedModels = allowedModels;
      body.rpmLimit = rpmLimit ?? null;
      body.tpmLimit = tpmLimit ?? null;
      body.quotaTokens = quotaTokens ?? null;
    } else {
      if (allowedModels.length > 0) body.allowedModels = allowedModels;
      if (rpmLimit !== undefined) body.rpmLimit = rpmLimit;
      if (tpmLimit !== undefined) body.tpmLimit = tpmLimit;
      if (quotaTokens !== undefined) body.quotaTokens = quotaTokens;
    }

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
            {data.adminError}。在设置中保存 Gateway Key，或配置单独的管理员 Key 后即可进行写操作。
          </div>
          <Button variant="outline" size="sm" onClick={() => onNavigate("settings")}>
            前往设置
          </Button>
        </div>
      )}
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
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <ChannelForm
          providers={providerOptions}
          models={data.models.map((item) => item.id)}
          draft={channel}
          saving={saving === "channel"}
          disabled={adminDisabled}
          editing={Boolean(editingChannelId)}
          onChange={updateChannel}
          onMappingsChange={updateChannelMappings}
          onCancel={resetChannel}
          onSubmit={saveChannel}
        />
        <KeyForm
          models={data.models.map((item) => item.id)}
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
  models,
  draft,
  saving,
  disabled,
  editing,
  onChange,
  onMappingsChange,
  onCancel,
  onSubmit,
}: {
  providers: string[];
  models: string[];
  draft: ChannelDraft;
  saving: boolean;
  disabled: boolean;
  editing: boolean;
  onChange: (name: keyof ChannelDraft, value: string) => void;
  onMappingsChange: (value: ModelMappingDraft[]) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const providerOptions = Array.from(new Set([...providers, draft.providerId].filter(Boolean)));
  const advancedCount = [
    editing && draft.id,
    editing && draft.name,
    editing && draft.authRef,
    draft.upstreamUrl,
    draft.priority !== "100" ? draft.priority : "",
    draft.weight !== "1" ? draft.weight : "",
    draft.modelMappings.length > 0 ? "mapping" : "",
  ].filter(Boolean).length;
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
            : "选择 Provider 即可使用默认渠道；复杂路由再展开高级设置。"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
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
          {draft.providerId && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/15 bg-primary/5 px-3.5 py-3 text-xs">
              <div className="flex items-center gap-2 text-foreground">
                <Network className="size-3.5 text-primary" />
                <span>将使用 Provider 默认地址和认证</span>
                <Badge variant="success">默认路由</Badge>
              </div>
              <span className="font-mono text-[11px] text-muted-foreground">{draft.id}</span>
            </div>
          )}
          <details className="group rounded-xl border border-border/70 bg-muted/10">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3 text-xs font-medium text-foreground [&::-webkit-details-marker]:hidden">
              <span className="flex items-center gap-2">
                <SlidersHorizontal className="size-3.5 text-primary" />
                高级路由设置
              </span>
              <span className="flex items-center gap-2 text-[11px] font-normal text-muted-foreground">
                {advancedCount ? `${advancedCount} 项已配置` : "使用默认值"}
                <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
              </span>
            </summary>
            <div className="space-y-4 border-t border-border/60 px-3.5 py-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={editing ? "渠道 ID" : "渠道 ID（可选）"} htmlFor="channel-id">
                  <Input
                    id="channel-id"
                    required
                    value={draft.id}
                    onChange={(event) => onChange("id", event.target.value)}
                    placeholder="自动生成"
                    disabled={editing || disabled}
                  />
                  {!editing && (
                    <p className="text-[11px] leading-4 text-muted-foreground">
                      默认按 Provider 生成；需要多条同类渠道时再修改。
                    </p>
                  )}
                </Field>
                <Field label="显示名称（可选）" htmlFor="channel-name">
                  <Input
                    id="channel-name"
                    value={draft.name}
                    onChange={(event) => onChange("name", event.target.value)}
                    placeholder="默认使用渠道 ID"
                    disabled={disabled}
                  />
                </Field>
                <Field label="认证引用（可选）" htmlFor="channel-auth-ref">
                  <Input
                    id="channel-auth-ref"
                    value={draft.authRef}
                    onChange={(event) => onChange("authRef", event.target.value)}
                    placeholder={draft.providerId || "默认使用 Provider ID"}
                    disabled={disabled}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
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
              <ModelMappingEditor
                models={models}
                mappings={draft.modelMappings}
                disabled={disabled}
                onChange={onMappingsChange}
              />
            </div>
          </details>
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

function ModelMappingEditor({
  models,
  mappings,
  disabled,
  onChange,
}: {
  models: string[];
  mappings: ModelMappingDraft[];
  disabled: boolean;
  onChange: (value: ModelMappingDraft[]) => void;
}) {
  const update = (id: string, field: "publicModel" | "upstreamModel", value: string): void => {
    onChange(
      mappings.map((mapping) => (mapping.id === id ? { ...mapping, [field]: value } : mapping)),
    );
  };

  const add = (): void => {
    onChange([...mappings, { id: `mapping-${Date.now()}`, publicModel: "", upstreamModel: "" }]);
  };

  const remove = (id: string): void => {
    onChange(mappings.filter((mapping) => mapping.id !== id));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-foreground">模型映射（可选）</div>
          <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
            将公开模型名映射到 Provider 的上游模型；不配置时保持原模型名。
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={disabled}>
          <Plus className="size-3.5" />
          添加映射
        </Button>
      </div>
      {mappings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 px-3 py-2.5 text-[11px] text-muted-foreground">
          暂无映射，默认直接使用请求中的模型名。
        </div>
      ) : (
        <div className="space-y-2">
          {mappings.map((mapping) => (
            <div key={mapping.id} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <Input
                list="channel-model-options"
                value={mapping.publicModel}
                onChange={(event) => update(mapping.id, "publicModel", event.target.value)}
                placeholder="公开模型名"
                disabled={disabled}
                aria-label="公开模型名"
              />
              <Input
                value={mapping.upstreamModel}
                onChange={(event) => update(mapping.id, "upstreamModel", event.target.value)}
                placeholder="上游模型名"
                disabled={disabled}
                aria-label="上游模型名"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => remove(mapping.id)}
                disabled={disabled}
                title="删除映射"
                aria-label="删除映射"
              >
                <Trash2 className="size-3.5 text-red-300" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <datalist id="channel-model-options">
        {models.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
    </div>
  );
}

function KeyForm({
  models,
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
  models: string[];
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
  const advancedCount = [
    draft.allowedModels.trim(),
    draft.rpmLimit,
    draft.tpmLimit,
    draft.quotaTokens,
  ].filter(Boolean).length;
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
            : "填写名称即可创建；默认允许全部模型且不限制用量。"}
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
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/15 bg-primary/5 px-3.5 py-3 text-xs">
            <KeyRound className="size-3.5 text-primary" />
            <span>默认访问策略</span>
            <Badge variant="success">全部模型</Badge>
            <Badge variant="muted">不限用量</Badge>
          </div>
          <details className="group rounded-xl border border-border/70 bg-muted/10">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3 text-xs font-medium text-foreground [&::-webkit-details-marker]:hidden">
              <span className="flex items-center gap-2">
                <SlidersHorizontal className="size-3.5 text-primary" />
                访问策略（可选）
              </span>
              <span className="flex items-center gap-2 text-[11px] font-normal text-muted-foreground">
                {advancedCount ? `${advancedCount} 项已配置` : "全部模型 · 不限用量"}
                <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
              </span>
            </summary>
            <div className="space-y-4 border-t border-border/60 px-3.5 py-4">
              <Field label="允许模型（可选）" htmlFor="key-allowed-models">
                <Input
                  id="key-allowed-models"
                  list="key-model-options"
                  value={draft.allowedModels}
                  onChange={(event) => onChange("allowedModels", event.target.value)}
                  placeholder="留空表示全部模型；多个模型用逗号分隔"
                  disabled={disabled}
                />
                <p className="text-[11px] leading-4 text-muted-foreground">
                  可直接输入模型名，或从浏览器提示中选择。
                </p>
                <datalist id="key-model-options">
                  {models.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="RPM（可选）" htmlFor="key-rpm">
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
                <Field label="TPM（可选）" htmlFor="key-tpm">
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
                <Field label="Token 配额（可选）" htmlFor="key-quota">
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
            </div>
          </details>
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
