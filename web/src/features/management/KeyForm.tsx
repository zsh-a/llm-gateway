import { Check, ChevronDown, Copy, KeyRound, Plus, Save, SlidersHorizontal } from "lucide-react";
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
  Spinner,
} from "../../components/ui";
import type { KeyDraft } from "./types";

export function KeyForm({
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
