import { Plus, Trash2 } from "lucide-react";
import { Button, Input } from "../../components/ui";
import type { ModelMappingDraft } from "./types";

export function ModelMappingEditor({
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
