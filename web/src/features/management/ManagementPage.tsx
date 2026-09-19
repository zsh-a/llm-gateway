import { AlertCircle } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { GatewayApi } from "../../api";
import { Button, ConfirmDialog } from "../../components/ui";
import { cn } from "../../lib/utils";
import type {
  ApiKeyInput,
  ApiKeyRecord,
  ChannelConfig,
  ChannelInput,
  DashboardData,
  Navigate,
  NoticeTone,
} from "../../types";
import { ApiKeyList } from "./ApiKeyList";
import { ChannelForm } from "./ChannelForm";
import { ChannelList } from "./ChannelList";
import { KeyForm } from "./KeyForm";
import {
  type ChannelDraft,
  type Confirmation,
  channelDraftFrom,
  initialChannel,
  initialKey,
  type KeyDraft,
  keyDraftFrom,
  type ModelMappingDraft,
  optionalInteger,
  type SavingForm,
  serializeMappings,
  suggestedChannelId,
} from "./types";

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
