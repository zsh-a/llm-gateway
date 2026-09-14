import {
  AlertCircle,
  Check,
  Copy,
  KeyRound,
  Network,
  Plus,
  RefreshCw,
  Save,
  Trash2
} from "lucide-react";
import {
  useState,
  type FormEvent
} from "react";
import type {
  ApiKeyRecord,
  ChannelConfig,
  DashboardData
} from "../types";
import type { GatewayApi } from "../api";
import { formatCompact } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input
} from "../components/ui";
import {
  EmptyState,
  Field,
  StatusBadge
} from "../components/common";

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

const initialChannel: ChannelDraft = {
  id: "",
  name: "",
  providerId: "",
  authRef: "",
  upstreamUrl: "",
  priority: "100",
  weight: "1",
  modelMappings: ""
};

const initialKey: KeyDraft = {
  name: "",
  allowedModels: "",
  rpmLimit: "",
  tpmLimit: "",
  quotaTokens: ""
};

export function ManagementPage({
  data,
  api,
  onRefresh,
  onNotice
}: {
  data: DashboardData;
  api: GatewayApi;
  onRefresh: () => void;
  onNotice: (message: string) => void;
}) {
  const [channel, setChannel] = useState<ChannelDraft>(initialChannel);
  const [key, setKey] = useState<KeyDraft>(initialKey);
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [copyState, setCopyState] = useState(false);

  const updateChannel = (name: keyof ChannelDraft, value: string): void => {
    setChannel((current) => ({ ...current, [name]: value }));
  };
  const updateKey = (name: keyof KeyDraft, value: string): void => {
    setKey((current) => ({ ...current, [name]: value }));
  };

  const saveChannel = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!channel.id || !channel.providerId || !channel.authRef) {
      onNotice("渠道 ID、Provider 和认证引用不能为空");
      return;
    }
    setSaving(true);
    try {
      let modelMappings: Record<string, string> | undefined;
      if (channel.modelMappings.trim()) {
        try {
          modelMappings = JSON.parse(channel.modelMappings) as Record<string, string>;
        } catch {
          onNotice("模型映射必须是合法 JSON 对象");
          return;
        }
      }
      await api.saveChannel({
        id: channel.id,
        name: channel.name || channel.id,
        providerId: channel.providerId,
        authRef: channel.authRef,
        upstreamUrl: channel.upstreamUrl || undefined,
        enabled: true,
        priority: Number(channel.priority) || 100,
        weight: Number(channel.weight) || 1,
        modelMappings
      });
      onNotice("渠道已保存");
      setChannel({ ...initialChannel });
      onRefresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "保存渠道失败");
    } finally {
      setSaving(false);
    }
  };

  const createKey = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!key.name) {
      onNotice("请填写 Key 名称");
      return;
    }
    setSaving(true);
    try {
      const created = await api.createKey({
        name: key.name,
        allowedModels: key.allowedModels.split(",").map((item) => item.trim()).filter(Boolean),
        ...(key.rpmLimit ? { rpmLimit: Number(key.rpmLimit) } : {}),
        ...(key.tpmLimit ? { tpmLimit: Number(key.tpmLimit) } : {}),
        ...(key.quotaTokens ? { quotaTokens: Number(key.quotaTokens) } : {})
      });
      setSecret(created.secret);
      setKey({ ...initialKey });
      onRefresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "创建 Key 失败");
    } finally {
      setSaving(false);
    }
  };

  const removeChannel = async (item: ChannelConfig): Promise<void> => {
    if (!window.confirm("确认删除渠道「" + (item.name || item.id) + "」？")) return;
    try {
      await api.deleteChannel(item.id);
      onRefresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "删除渠道失败");
    }
  };

  const toggleChannel = async (item: ChannelConfig): Promise<void> => {
    try {
      await api.saveChannel({ ...item, enabled: item.enabled === false });
      onRefresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "更新渠道失败");
    }
  };

  const revokeKey = async (item: ApiKeyRecord): Promise<void> => {
    if (!window.confirm("确认撤销 Key「" + item.name + "」？")) return;
    try {
      await api.revokeKey(item.id);
      onRefresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "撤销 Key 失败");
    }
  };

  const copySecret = async (): Promise<void> => {
    if (!secret) return;
    await navigator.clipboard?.writeText(secret);
    setCopyState(true);
    window.setTimeout(() => setCopyState(false), 1600);
  };

  return (
    <div className="space-y-6">
      {data.adminError && <div className="flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/10 p-3 text-sm text-amber-200"><AlertCircle className="mt-0.5 size-4 shrink-0" />{data.adminError}。在设置中保存管理员 API Key 后即可进行写操作。</div>}
      <div className="grid gap-6 xl:grid-cols-2">
        <ChannelForm draft={channel} saving={saving} disabled={Boolean(data.adminError)} onChange={updateChannel} onSubmit={saveChannel} />
        <KeyForm draft={key} saving={saving} disabled={Boolean(data.adminError)} secret={secret} copyState={copyState} onChange={updateKey} onSubmit={createKey} onCopy={copySecret} />
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <ChannelList items={data.channels} onToggle={(item) => void toggleChannel(item)} onRemove={(item) => void removeChannel(item)} />
        <ApiKeyList items={data.keys} onRevoke={(item) => void revokeKey(item)} />
      </div>
    </div>
  );
}

function ChannelForm({
  draft,
  saving,
  disabled,
  onChange,
  onSubmit
}: {
  draft: ChannelDraft;
  saving: boolean;
  disabled: boolean;
  onChange: (name: keyof ChannelDraft, value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Card>
      <CardHeader><div className="flex items-center gap-2"><Network className="size-4 text-primary" /><CardTitle>新增渠道</CardTitle></div><CardDescription>通过 Provider、认证引用和优先级组成统一路由。</CardDescription></CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="渠道 ID"><Input value={draft.id} onChange={(event) => onChange("id", event.target.value)} placeholder="mimo-primary" /></Field>
            <Field label="显示名称"><Input value={draft.name} onChange={(event) => onChange("name", event.target.value)} placeholder="MiMo 主渠道" /></Field>
            <Field label="Provider"><Input value={draft.providerId} onChange={(event) => onChange("providerId", event.target.value)} placeholder="mimo / workbuddy" /></Field>
            <Field label="认证引用"><Input value={draft.authRef} onChange={(event) => onChange("authRef", event.target.value)} placeholder="mimo" /></Field>
            <Field label="优先级"><Input inputMode="numeric" value={draft.priority} onChange={(event) => onChange("priority", event.target.value)} placeholder="100" /></Field>
            <Field label="权重"><Input inputMode="numeric" value={draft.weight} onChange={(event) => onChange("weight", event.target.value)} placeholder="1" /></Field>
          </div>
          <Field label="上游 URL（可选）"><Input value={draft.upstreamUrl} onChange={(event) => onChange("upstreamUrl", event.target.value)} placeholder="留空使用 Provider 默认地址" /></Field>
          <Field label="模型映射 JSON（可选）"><Input value={draft.modelMappings} onChange={(event) => onChange("modelMappings", event.target.value)} placeholder={'{"public-model":"upstream-model"}'} /></Field>
          <Button type="submit" disabled={saving || disabled}><Save className="size-4" />{saving ? "保存中..." : "保存渠道"}</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function KeyForm({
  draft,
  saving,
  disabled,
  secret,
  copyState,
  onChange,
  onSubmit,
  onCopy
}: {
  draft: KeyDraft;
  saving: boolean;
  disabled: boolean;
  secret: string;
  copyState: boolean;
  onChange: (name: keyof KeyDraft, value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCopy: () => void;
}) {
  return (
    <Card>
      <CardHeader><div className="flex items-center gap-2"><KeyRound className="size-4 text-cyan-300" /><CardTitle>创建访问 Key</CardTitle></div><CardDescription>为 Cline、Roo、DeepSeek Harness 等客户端分配独立凭证。</CardDescription></CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <Field label="Key 名称"><Input value={draft.name} onChange={(event) => onChange("name", event.target.value)} placeholder="local-client" /></Field>
          <Field label="允许模型"><Input value={draft.allowedModels} onChange={(event) => onChange("allowedModels", event.target.value)} placeholder="留空表示全部模型，多个模型用逗号分隔" /></Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="RPM"><Input inputMode="numeric" value={draft.rpmLimit} onChange={(event) => onChange("rpmLimit", event.target.value)} placeholder="不限" /></Field>
            <Field label="TPM"><Input inputMode="numeric" value={draft.tpmLimit} onChange={(event) => onChange("tpmLimit", event.target.value)} placeholder="不限" /></Field>
            <Field label="Token 配额"><Input inputMode="numeric" value={draft.quotaTokens} onChange={(event) => onChange("quotaTokens", event.target.value)} placeholder="不限" /></Field>
          </div>
          <Button type="submit" disabled={saving || disabled}><Plus className="size-4" />创建 Key</Button>
        </form>
        {secret && <div className="mt-5 rounded-xl border border-emerald-400/25 bg-emerald-400/10 p-3"><div className="mb-2 flex items-center justify-between gap-2"><div className="text-xs font-medium text-emerald-200">Secret 只显示这一次，请立即保存</div><Button variant="ghost" size="sm" onClick={onCopy}>{copyState ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copyState ? "已复制" : "复制"}</Button></div><code className="block break-all rounded-lg bg-black/15 p-2 font-mono text-xs text-emerald-100">{secret}</code></div>}
      </CardContent>
    </Card>
  );
}

function ChannelList({
  items,
  onToggle,
  onRemove
}: {
  items: ChannelConfig[];
  onToggle: (item: ChannelConfig) => void;
  onRemove: (item: ChannelConfig) => void;
}) {
  return (
    <Card>
      <CardHeader><CardTitle>渠道列表</CardTitle><CardDescription>{items.length} 个已配置渠道</CardDescription></CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 && <EmptyState icon={Network} title="暂无渠道" />}
        {items.map((item) => (
          <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/15 px-3.5 py-3">
            <div className="flex min-w-0 items-center gap-3"><div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Network className="size-4" /></div><div className="min-w-0"><div className="truncate text-sm font-medium">{item.name || item.id}</div><div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{item.id} · {item.providerId} · {item.authRef}</div></div></div>
            <div className="flex shrink-0 items-center gap-2"><StatusBadge status={item.enabled === false ? "offline" : "ready"} label={item.enabled === false ? "停用" : "启用"} /><Button variant="ghost" size="icon" onClick={() => onToggle(item)} title="切换状态"><RefreshCw className="size-3.5" /></Button><Button variant="ghost" size="icon" onClick={() => onRemove(item)} title="删除"><Trash2 className="size-3.5 text-red-300" /></Button></div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ApiKeyList({ items, onRevoke }: { items: ApiKeyRecord[]; onRevoke: (item: ApiKeyRecord) => void }) {
  return (
    <Card>
      <CardHeader><CardTitle>虚拟 API Keys</CardTitle><CardDescription>{items.length} 个已管理密钥</CardDescription></CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 && <EmptyState icon={KeyRound} title="暂无虚拟 Key" />}
        {items.map((item) => (
          <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/15 px-3.5 py-3">
            <div className="flex min-w-0 items-center gap-3"><div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-300"><KeyRound className="size-4" /></div><div className="min-w-0"><div className="truncate text-sm font-medium">{item.name}</div><div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{item.prefix}… · 已用 {formatCompact(item.usedTokens)} tokens</div></div></div>
            <div className="flex shrink-0 items-center gap-2">{item.enabled ? <Badge variant="success">启用</Badge> : <Badge variant="muted">已撤销</Badge>}{item.enabled && <Button variant="ghost" size="icon" onClick={() => onRevoke(item)} title="撤销"><Trash2 className="size-3.5 text-red-300" /></Button>}</div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

