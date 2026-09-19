import { ChevronDown, Network, Save, SlidersHorizontal } from "lucide-react";
import type { FormEvent } from "react";
import { Field } from "../../components/common";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  Spinner,
} from "../../components/ui";
import { ModelMappingEditor } from "./ModelMappingEditor";
import type { ChannelDraft, ModelMappingDraft } from "./types";

export function ChannelForm({
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
