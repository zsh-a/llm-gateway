import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Field } from "../../components/common";
import { ModelPicker } from "../../components/ModelPicker";
import { Button, Input, Spinner } from "../../components/ui";
import type { ApiKeyInput, ApiKeyRecord, GatewayModel } from "../../types";
import { initialKey, type KeyDraft, keyDraftFrom, keyInput, keySchema } from "./types";

export function KeyForm({
  models,
  item,
  disabled,
  onDirtyChange,
  onCancel,
  onSave,
}: {
  models: GatewayModel[];
  item?: ApiKeyRecord;
  disabled: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
  onSave: (input: ApiKeyInput) => Promise<void>;
}) {
  const form = useForm<KeyDraft>({
    resolver: zodResolver(keySchema),
    defaultValues: item ? keyDraftFrom(item) : initialKey,
  });
  const {
    register,
    watch,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = form;
  const draft = watch();
  const [advanced, setAdvanced] = useState(
    Boolean(
      item && (item.allowedModels.length || item.rpmLimit || item.tpmLimit || item.quotaTokens),
    ),
  );
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);
  const limits = [
    draft.rpmLimit && `RPM ${draft.rpmLimit}`,
    draft.tpmLimit && `TPM ${draft.tpmLimit}`,
    draft.quotaTokens && `配额 ${draft.quotaTokens}`,
  ].filter(Boolean);
  const busy = disabled || isSubmitting;
  return (
    <form
      className="space-y-5"
      noValidate
      onSubmit={form.handleSubmit(
        async (values) => {
          try {
            await onSave(keyInput(values, Boolean(item)));
          } catch (error) {
            setError("root", {
              message: error instanceof Error ? error.message : "保存失败，请重试",
            });
          }
        },
        () => setAdvanced(true),
      )}
    >
      <Field label="Key 名称" htmlFor="key-name" error={errors.name?.message}>
        <Input
          id="key-name"
          {...register("name")}
          placeholder="例如：本地开发"
          disabled={busy}
          aria-invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? "key-name-error" : undefined}
        />
      </Field>
      <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
        {draft.allowedModels.length ? `允许 ${draft.allowedModels.length} 个模型` : "允许全部模型"}{" "}
        · {limits.length ? limits.join(" · ") : "不限用量"}
      </p>
      <details
        open={advanced}
        onToggle={(event) => setAdvanced(event.currentTarget.open)}
        className="group border-t pt-4"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium [&::-webkit-details-marker]:hidden">
          访问权限与限额
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-5 space-y-5">
          <Field
            label="允许的模型"
            htmlFor="key-allowed-models"
            error={errors.allowedModels?.message}
          >
            <Controller
              control={form.control}
              name="allowedModels"
              render={({ field }) => (
                <ModelPicker
                  id="key-allowed-models"
                  models={models}
                  multiple
                  allowCustom
                  value={field.value}
                  onChange={field.onChange}
                  disabled={busy}
                  invalid={Boolean(errors.allowedModels)}
                />
              )}
            />
            <p className="text-xs text-muted-foreground">
              留空允许全部模型，也可添加尚未发现的模型 ID。
            </p>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="每分钟请求数（RPM）" htmlFor="key-rpm" error={errors.rpmLimit?.message}>
              <Input
                id="key-rpm"
                {...register("rpmLimit")}
                type="number"
                min="1"
                placeholder="不限"
                disabled={busy}
                aria-invalid={Boolean(errors.rpmLimit)}
                aria-describedby={errors.rpmLimit ? "key-rpm-error" : undefined}
              />
            </Field>
            <Field label="每分钟 Token（TPM）" htmlFor="key-tpm" error={errors.tpmLimit?.message}>
              <Input
                id="key-tpm"
                {...register("tpmLimit")}
                type="number"
                min="1"
                placeholder="不限"
                disabled={busy}
                aria-invalid={Boolean(errors.tpmLimit)}
                aria-describedby={errors.tpmLimit ? "key-tpm-error" : undefined}
              />
            </Field>
          </div>
          <Field label="Token 总配额" htmlFor="key-quota" error={errors.quotaTokens?.message}>
            <Input
              id="key-quota"
              {...register("quotaTokens")}
              type="number"
              min="1"
              placeholder="不限"
              disabled={busy}
              aria-invalid={Boolean(errors.quotaTokens)}
              aria-describedby={errors.quotaTokens ? "key-quota-error" : undefined}
            />
          </Field>
        </div>
      </details>
      {errors.root && (
        <p role="alert" className="text-sm text-destructive">
          {errors.root.message}
        </p>
      )}
      <div className="sticky -bottom-6 -mx-6 flex justify-end gap-2 border-t bg-background px-6 py-4">
        <Button variant="outline" onClick={onCancel} disabled={isSubmitting}>
          取消
        </Button>
        <Button type="submit" disabled={busy}>
          {isSubmitting && <Spinner />}
          {item ? "保存修改" : "创建 Key"}
        </Button>
      </div>
    </form>
  );
}
