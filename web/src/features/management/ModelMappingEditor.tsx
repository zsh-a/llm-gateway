import { Plus, Trash2 } from "lucide-react";
import { type UseFormReturn, useFieldArray } from "react-hook-form";
import { Field } from "../../components/common";
import { Button, Input } from "../../components/ui";
import type { ChannelDraft } from "./types";

export function ModelMappingEditor({
  form,
  models,
  disabled,
}: {
  form: UseFormReturn<ChannelDraft>;
  models: string[];
  disabled: boolean;
}) {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "modelMappings",
  });
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">模型映射</div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => append({ publicModel: "", upstreamModel: "" })}
          disabled={disabled}
        >
          <Plus className="size-3.5" />
          添加映射
        </Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        将公开模型名映射到上游模型。留空时使用原模型名。
      </p>
      {fields.map((field, index) => (
        <div
          key={field.id}
          className="grid grid-cols-[1fr_auto] items-start gap-2 rounded-lg border p-3"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="公开模型"
              htmlFor={`mapping-public-${field.id}`}
              error={form.formState.errors.modelMappings?.[index]?.publicModel?.message}
            >
              <Input
                id={`mapping-public-${field.id}`}
                list="channel-model-options"
                {...form.register(`modelMappings.${index}.publicModel`)}
                disabled={disabled}
                aria-invalid={Boolean(form.formState.errors.modelMappings?.[index]?.publicModel)}
                aria-describedby={
                  form.formState.errors.modelMappings?.[index]?.publicModel
                    ? `mapping-public-${field.id}-error`
                    : undefined
                }
              />
            </Field>
            <Field
              label="上游模型"
              htmlFor={`mapping-upstream-${field.id}`}
              error={form.formState.errors.modelMappings?.[index]?.upstreamModel?.message}
            >
              <Input
                id={`mapping-upstream-${field.id}`}
                {...form.register(`modelMappings.${index}.upstreamModel`)}
                disabled={disabled}
                aria-invalid={Boolean(form.formState.errors.modelMappings?.[index]?.upstreamModel)}
                aria-describedby={
                  form.formState.errors.modelMappings?.[index]?.upstreamModel
                    ? `mapping-upstream-${field.id}-error`
                    : undefined
                }
              />
            </Field>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="mt-7"
            onClick={() => remove(index)}
            disabled={disabled}
            aria-label={`删除第 ${index + 1} 条映射`}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <datalist id="channel-model-options">
        {models.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
    </div>
  );
}
