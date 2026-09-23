import { Tabs } from "@base-ui/react/tabs";
import { useMutation } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import type { ComponentProps } from "react";
import { useEffect, useRef, useState } from "react";
import type { GatewayApi } from "../../api";
import { CopyButton, ResourceContent } from "../../components/common";
import { Button, ConfirmDialog, Sheet } from "../../components/ui";
import { useAuth, useChannels, useKeys, useModels } from "../../lib/gateway-queries";
import { gatewayQueryKeys, queryClient } from "../../lib/query";
import type {
  ApiKeyInput,
  ApiKeyRecord,
  ApiKeyUpdate,
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
import type { Confirmation } from "./types";

type Editor = { kind: "channel"; item?: ChannelConfig } | { kind: "key"; item?: ApiKeyRecord };

export function ManagementPage({
  data,
  api,
  initialKeyId,
  onNotice,
  onNavigate,
  serviceAvailable = true,
}: {
  initialKeyId?: string;
  data: Pick<DashboardData, "health" | "auth" | "models" | "channels" | "keys"> & {
    resources: Pick<DashboardData["resources"], "channels" | "keys">;
  };
  api: GatewayApi;
  onNotice: (message: string, tone?: NoticeTone) => void;
  onNavigate: Navigate;
  serviceAvailable?: boolean;
}) {
  const [tab, setTab] = useState("channels");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [dirty, setDirty] = useState(false);
  const openedKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialKeyId || openedKey.current === initialKeyId) return;
    const key = data.keys.find((item) => item.id === initialKeyId);
    if (!key) return;
    openedKey.current = initialKeyId;
    setTab("keys");
    if (!key.revokedAt) setEditor({ kind: "key", item: key });
  }, [initialKeyId, data.keys]);

  const [discard, setDiscard] = useState(false);
  const [secret, setSecret] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const invalidate = (...resources: string[]) =>
    Promise.all(
      resources.map((resource) =>
        queryClient.invalidateQueries({
          queryKey: gatewayQueryKeys.resource(api.baseUrl, resource),
        }),
      ),
    );
  const channelMutation = useMutation({
    mutationFn: (input: ChannelInput) => api.saveChannel(input),
    onSuccess: () => invalidate("channels", "models", "auth"),
  });
  const keyMutation = useMutation({
    mutationFn: async ({ id, input }: { id?: string; input: ApiKeyInput | ApiKeyUpdate }) => {
      if (id) {
        await api.updateKey(id, input);
        return "";
      }
      return (await api.createKey(input as ApiKeyInput)).secret;
    },
    onSuccess: () => invalidate("keys", "models", "metrics"),
  });
  const removeMutation = useMutation({
    mutationFn: (target: Confirmation) =>
      target.kind === "channel" ? api.deleteChannel(target.item.id) : api.revokeKey(target.item.id),
    onSuccess: (_, target) =>
      target.kind === "channel" ? invalidate("channels", "models") : invalidate("keys", "metrics"),
  });
  const busy = channelMutation.isPending || keyMutation.isPending || removeMutation.isPending;
  const providers = Array.from(
    new Set([...(data.health.providers ?? []), ...Object.keys(data.auth.providers)]),
  );
  const finishEditing = () => {
    setEditor(null);
    setDirty(false);
    setDiscard(false);
  };
  const closeEditor = () => {
    if (busy) return;
    if (dirty) setDiscard(true);
    else finishEditing();
  };
  const run = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      onNotice(success);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "操作失败，请重试", "error");
    }
  };
  const resource = tab === "channels" ? data.resources.channels : data.resources.keys;

  return (
    <div className="space-y-5">
      <Tabs.Root value={tab} onValueChange={(value) => setTab(String(value))}>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <Tabs.List className="inline-flex gap-1 rounded-lg bg-muted p-1" aria-label="资源类型">
            <Tabs.Tab
              value="channels"
              className="rounded-md px-4 py-2 text-sm text-muted-foreground data-active:bg-card data-active:text-foreground data-active:shadow-sm"
            >
              渠道{" "}
              <span className="ml-1 text-xs">
                {data.resources.channels.hasData ? data.channels.length : "—"}
              </span>
            </Tabs.Tab>
            <Tabs.Tab
              value="keys"
              className="rounded-md px-4 py-2 text-sm text-muted-foreground data-active:bg-card data-active:text-foreground data-active:shadow-sm"
            >
              API Keys{" "}
              <span className="ml-1 text-xs">
                {data.resources.keys.hasData ? data.keys.length : "—"}
              </span>
            </Tabs.Tab>
          </Tabs.List>
          <Button
            disabled={!serviceAvailable || busy || !resource.hasData || Boolean(resource.error)}
            onClick={() => {
              setDirty(false);
              setEditor({ kind: tab === "channels" ? "channel" : "key" });
            }}
          >
            <Plus className="size-4" />
            {tab === "channels" ? "新增渠道" : "创建 Key"}
          </Button>
        </div>
        {resource.error && (
          <div className="mb-4 flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>请检查网关连接及访问凭证。</span>
            <Button variant="outline" size="sm" onClick={() => onNavigate("settings")}>
              连接设置
            </Button>
          </div>
        )}
        <Tabs.Panel value="channels">
          <ResourceContent state={data.resources.channels} label="渠道">
            <ChannelList
              items={data.channels}
              disabled={!serviceAvailable || busy || Boolean(data.resources.channels.error)}
              onEdit={(item) => {
                setDirty(false);
                setEditor({ kind: "channel", item });
              }}
              onToggle={(item) =>
                void run(
                  () => channelMutation.mutateAsync({ ...item, enabled: item.enabled === false }),
                  item.enabled === false ? "渠道已启用" : "渠道已停用",
                )
              }
              onRemove={(item) => setConfirmation({ kind: "channel", item })}
            />
          </ResourceContent>
        </Tabs.Panel>
        <Tabs.Panel value="keys">
          <ResourceContent state={data.resources.keys} label="API Keys">
            <ApiKeyList
              onUsage={(id) => onNavigate("metrics", { apiKeyId: id })}
              items={data.keys}
              disabled={!serviceAvailable || busy || Boolean(data.resources.keys.error)}
              onEdit={(item) => {
                setDirty(false);
                setEditor({ kind: "key", item });
              }}
              onToggle={(item) =>
                void run(
                  () => keyMutation.mutateAsync({ id: item.id, input: { enabled: !item.enabled } }),
                  item.enabled ? "Key 已停用" : "Key 已启用",
                )
              }
              onRevoke={(item) => setConfirmation({ kind: "key", item })}
            />
          </ResourceContent>
        </Tabs.Panel>
      </Tabs.Root>
      <Sheet
        open={Boolean(editor)}
        onClose={closeEditor}
        dismissible={!busy}
        title={
          editor?.kind === "channel"
            ? editor.item
              ? "编辑渠道"
              : "新增渠道"
            : editor?.item
              ? "编辑 API Key"
              : "创建 API Key"
        }
        description={
          editor?.kind === "channel"
            ? "配置模型访问的上游与路由。"
            : "配置客户端的模型权限和用量限额。"
        }
      >
        {editor?.kind === "channel" && (
          <ChannelForm
            key={editor.item?.id ?? "new-channel"}
            providers={providers}
            models={data.models.map((model) => model.id)}
            channels={data.channels}
            item={editor.item}
            disabled={!serviceAvailable || Boolean(data.resources.channels.error)}
            onDirtyChange={setDirty}
            onCancel={closeEditor}
            onSave={async (input) => {
              await channelMutation.mutateAsync(input);
              onNotice(editor.item ? "渠道已更新" : "渠道已创建");
              finishEditing();
            }}
          />
        )}
        {editor?.kind === "key" && (
          <KeyForm
            key={editor.item?.id ?? "new-key"}
            models={data.models}
            item={editor.item}
            disabled={!serviceAvailable || Boolean(data.resources.keys.error)}
            onDirtyChange={setDirty}
            onCancel={closeEditor}
            onSave={async (input) => {
              const createdSecret = await keyMutation.mutateAsync({ id: editor.item?.id, input });
              finishEditing();
              if (createdSecret) setSecret(createdSecret);
              else onNotice("Key 已更新");
            }}
          />
        )}
        <ConfirmDialog
          open={discard}
          title="放弃未保存的修改？"
          description="关闭后，本次尚未保存的配置将丢失。"
          confirmLabel="放弃修改"
          onConfirm={finishEditing}
          onCancel={() => setDiscard(false)}
        />
      </Sheet>
      <Sheet
        open={Boolean(secret)}
        dismissible={false}
        onClose={() => undefined}
        title="API Key 已创建"
        description="完整密钥仅显示这一次，请复制并妥善保存。"
      >
        <div className="space-y-5">
          <code className="block select-all break-all rounded-lg border bg-card p-4 font-mono text-sm">
            {secret}
          </code>
          <div className="flex items-center justify-between">
            <CopyButton value={secret} label="复制密钥" />
            <Button onClick={() => setSecret("")}>已保存，关闭</Button>
          </div>
        </div>
      </Sheet>
      <ConfirmDialog
        open={Boolean(confirmation)}
        title={confirmation?.kind === "channel" ? "删除渠道？" : "撤销 API Key？"}
        description={
          confirmation
            ? `「${confirmation.item.name || confirmation.item.id}」将立即停止提供访问，操作无法撤销。`
            : ""
        }
        confirmLabel={confirmation?.kind === "channel" ? "删除渠道" : "撤销 Key"}
        destructive
        loading={removeMutation.isPending}
        confirmDisabled={!serviceAvailable}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => {
          if (!confirmation || !serviceAvailable) return;
          void run(
            async () => {
              await removeMutation.mutateAsync(confirmation);
              setConfirmation(null);
            },
            confirmation.kind === "channel" ? "渠道已删除" : "Key 已撤销",
          );
        }}
      />
    </div>
  );
}

export function ManagementScreen({
  health,
  ...props
}: Omit<ComponentProps<typeof ManagementPage>, "data"> & { health: DashboardData["health"] }) {
  const auth = useAuth(props.api, props.serviceAvailable);
  const models = useModels(props.api, props.serviceAvailable);
  const channels = useChannels(props.api, props.serviceAvailable);
  const keys = useKeys(props.api, props.serviceAvailable);
  return (
    <ManagementPage
      {...props}
      data={{
        health,
        auth: auth.data,
        models: models.data,
        channels: channels.data,
        keys: keys.data,
        resources: { channels: channels.resource, keys: keys.resource },
      }}
    />
  );
}
