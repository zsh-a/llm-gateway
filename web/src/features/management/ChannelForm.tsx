import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Field } from "../../components/common";
import { Button, Input, Select, Spinner } from "../../components/ui";
import type { ChannelConfig, ChannelInput } from "../../types";
import { ModelMappingEditor } from "./ModelMappingEditor";
import {
  type ChannelDraft,
  channelDraftFrom,
  channelInput,
  channelSchema,
  initialChannel,
  suggestedChannelId,
} from "./types";

export function ChannelForm({
  providers,
  models,
  channels,
  item,
  disabled,
  onDirtyChange,
  onCancel,
  onSave,
}: {
  providers: string[];
  models: string[];
  channels: ChannelConfig[];
  item?: ChannelConfig;
  disabled: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
  onSave: (input: ChannelInput) => Promise<void>;
}) {
  const form = useForm<ChannelDraft>({
    resolver: zodResolver(channelSchema),
    defaultValues: item ? channelDraftFrom(item) : initialChannel,
  });
  const {
    register,
    watch,
    setValue,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = form;
  const draft = watch();
  const [advanced, setAdvanced] = useState(Boolean(item));
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);
  const options = Array.from(new Set([...providers, draft.providerId].filter(Boolean)));
  const custom = Boolean(
    draft.upstreamUrl.trim() ||
      (draft.authRef.trim() && draft.authRef.trim() !== draft.providerId) ||
      draft.priority !== "100" ||
      draft.weight !== "1" ||
      draft.modelMappings.some((row) => row.publicModel.trim()),
  );
  const busy = disabled || isSubmitting;
  return (
    <form
      className="space-y-5"
      noValidate
      onSubmit={form.handleSubmit(
        async (values) => {
          if (!item && channels.some((channel) => channel.id === values.id)) {
            setAdvanced(true);
            setError("id", { message: "该 ID 已存在，请使用新的渠道 ID" }, { shouldFocus: true });
            return;
          }
          try {
            await onSave(channelInput(values, item));
          } catch (error) {
            setError("root", {
              message: error instanceof Error ? error.message : "保存失败，请重试",
            });
          }
        },
        () => setAdvanced(true),
      )}
    >
      <Field label="Provider" htmlFor="channel-provider" error={errors.providerId?.message}>
        <Select
          id="channel-provider"
          {...register("providerId")}
          aria-invalid={Boolean(errors.providerId)}
          aria-describedby={errors.providerId ? "channel-provider-error" : undefined}
          disabled={busy || !options.length}
          onChange={(event) => {
            const value = event.target.value;
            setValue("providerId", value, { shouldDirty: true, shouldValidate: true });
            if (!item)
              setValue("id", value ? suggestedChannelId(value, channels) : "", {
                shouldDirty: true,
              });
          }}
        >
          <option value="">{options.length ? "选择 Provider" : "暂无可用 Provider"}</option>
          {options.map((provider) => (
            <option key={provider} value={provider}>
              {provider}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="显示名称" htmlFor="channel-name">
        <Input
          id="channel-name"
          {...register("name")}
          placeholder="可选，默认使用渠道 ID"
          disabled={busy}
        />
      </Field>
      {draft.providerId && (
        <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
          {custom ? "使用自定义路由配置" : "使用 Provider 的默认地址和认证"}
          <span className="mt-1 block break-all font-mono text-xs">{draft.id}</span>
        </p>
      )}
      <details
        open={advanced}
        onToggle={(event) => setAdvanced(event.currentTarget.open)}
        className="group border-t pt-4"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium [&::-webkit-details-marker]:hidden">
          高级路由设置
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-5 space-y-5">
          <Field label="渠道 ID" htmlFor="channel-id" error={errors.id?.message}>
            <Input
              id="channel-id"
              {...register("id")}
              readOnly={Boolean(item)}
              disabled={busy}
              aria-invalid={Boolean(errors.id)}
              aria-describedby={errors.id ? "channel-id-error" : undefined}
            />
          </Field>
          <Field label="认证引用" htmlFor="channel-auth-ref">
            <Input
              id="channel-auth-ref"
              {...register("authRef")}
              placeholder={draft.providerId || "默认使用 Provider 认证"}
              aria-describedby="channel-auth-help"
              disabled={busy}
            />
            <p id="channel-auth-help" className="text-xs leading-5 text-muted-foreground">
              引用已保存的认证名称；留空使用当前 Provider 的认证。
            </p>
          </Field>
          <Field
            label="上游地址"
            htmlFor="channel-upstream-url"
            error={errors.upstreamUrl?.message}
          >
            <Input
              id="channel-upstream-url"
              {...register("upstreamUrl")}
              placeholder="留空使用默认地址"
              disabled={busy}
              aria-invalid={Boolean(errors.upstreamUrl)}
              aria-describedby={errors.upstreamUrl ? "channel-upstream-url-error" : undefined}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="优先级" htmlFor="channel-priority" error={errors.priority?.message}>
              <Input
                id="channel-priority"
                {...register("priority")}
                type="number"
                min="0"
                disabled={busy}
                aria-invalid={Boolean(errors.priority)}
                aria-describedby={errors.priority ? "channel-priority-error" : undefined}
              />
              <p className="text-xs text-muted-foreground">数值越大越优先。</p>
            </Field>
            <Field label="权重" htmlFor="channel-weight" error={errors.weight?.message}>
              <Input
                id="channel-weight"
                {...register("weight")}
                type="number"
                min="1"
                disabled={busy}
                aria-invalid={Boolean(errors.weight)}
                aria-describedby={errors.weight ? "channel-weight-error" : undefined}
              />
              <p className="text-xs text-muted-foreground">同优先级按权重分配请求，如 2:1。</p>
            </Field>
          </div>
          <ModelMappingEditor form={form} models={models} disabled={busy} />
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
          {item ? "保存修改" : "创建渠道"}
        </Button>
      </div>
    </form>
  );
}
