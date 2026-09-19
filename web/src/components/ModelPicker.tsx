import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { searchModels } from "../lib/models";
import type { GatewayModel } from "../types";

type Props = {
  models: GatewayModel[];
  id?: string;
  label?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
} & (
  | { multiple?: false; value: string; onChange: (value: string) => void; allowCustom?: false }
  | { multiple: true; value: string[]; onChange: (value: string[]) => void; allowCustom?: boolean }
);

export function ModelPicker(props: Props) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const label = props.label ?? "选择模型";
  const [search, setSearch] = useState("");
  const items = useMemo(() => {
    const selectedIds = props.multiple ? props.value : props.value ? [props.value] : [];
    const result = [...props.models];
    for (const value of selectedIds) {
      if (!result.some((model) => model.id === value)) result.push({ id: value });
    }
    if (props.allowCustom && search.trim() && !result.some((model) => model.id === search.trim())) {
      result.push({ id: search.trim(), name: `添加「${search.trim()}」`, provider: "自定义" });
    }
    return result.sort((a, b) => (a.provider ?? "").localeCompare(b.provider ?? ""));
  }, [props.models, props.allowCustom, search, props.value, props.multiple]);
  const value = props.multiple
    ? props.value.map((id) => items.find((item) => item.id === id) ?? { id })
    : (items.find((item) => item.id === props.value) ?? null);

  return (
    <Combobox.Root<GatewayModel, boolean>
      items={items}
      value={value}
      multiple={props.multiple}
      disabled={props.disabled}
      autoHighlight
      filter={(item, query) => searchModels([item], query).length > 0}
      itemToStringLabel={(model) => model.name || model.id}
      itemToStringValue={(model) => model.id}
      isItemEqualToValue={(item, selected) => item.id === selected.id}
      onInputValueChange={setSearch}
      onValueChange={(next) => {
        if (props.multiple)
          props.onChange((Array.isArray(next) ? next : []).map((item) => item.id));
        else props.onChange(next && !Array.isArray(next) ? next.id : "");
      }}
    >
      {props.multiple ? (
        <Combobox.InputGroup className="min-h-10 rounded-lg border border-input bg-card p-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
          <Combobox.Value>
            {(selected: GatewayModel[]) => (
              <Combobox.Chips className="flex flex-wrap items-center gap-1.5" aria-label="已选模型">
                {selected.map((model) => (
                  <Combobox.Chip
                    key={model.id}
                    className="inline-flex max-w-full items-center gap-1 rounded-md bg-secondary px-2 py-1 text-xs text-secondary-foreground"
                    aria-label={model.id}
                  >
                    <span className="truncate">{model.id}</span>
                    <Combobox.ChipRemove
                      aria-label={`移除 ${model.id}`}
                      className="rounded p-0.5 hover:bg-primary/10"
                    >
                      <X className="size-3" />
                    </Combobox.ChipRemove>
                  </Combobox.Chip>
                ))}
                <Combobox.Input
                  id={id}
                  aria-label={label}
                  aria-invalid={props.invalid}
                  aria-describedby={props.describedBy}
                  placeholder={
                    selected.length
                      ? "继续添加…"
                      : (props.placeholder ?? "全部模型；搜索或输入模型 ID")
                  }
                  className="h-7 min-w-32 flex-1 bg-transparent px-1 text-sm outline-none"
                />
              </Combobox.Chips>
            )}
          </Combobox.Value>
        </Combobox.InputGroup>
      ) : (
        <Combobox.Trigger
          id={id}
          aria-label={label}
          aria-invalid={props.invalid}
          aria-describedby={props.describedBy}
          className="flex min-h-10 w-full items-center justify-between gap-2 rounded-lg border border-input bg-card px-3 py-2 text-left text-sm hover:bg-muted/50 disabled:opacity-50"
        >
          <span className="min-w-0 truncate">
            <Combobox.Value placeholder={props.placeholder ?? "选择模型"} />
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </Combobox.Trigger>
      )}
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={6} className="z-50 max-w-[var(--available-width)]">
          <Combobox.Popup className="w-[var(--anchor-width)] min-w-[min(20rem,var(--available-width))] max-w-[var(--available-width)] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg">
            {!props.multiple && (
              <div className="flex items-center gap-2 border-b px-3">
                <Search className="size-4 text-muted-foreground" />
                <Combobox.Input
                  aria-label="搜索模型"
                  placeholder="搜索名称、ID 或 Provider…"
                  className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none"
                />
              </div>
            )}
            <Combobox.Empty className="px-4 py-6 text-center text-sm text-muted-foreground">
              没有匹配的模型
            </Combobox.Empty>
            <Combobox.List className="max-h-[min(20rem,calc(var(--available-height)-4rem))] overflow-y-auto overscroll-contain p-1 scrollbar-thin">
              {(model: GatewayModel) => (
                <Combobox.Item
                  key={model.id}
                  value={model}
                  className="flex items-center gap-3 rounded-md px-3 py-2 text-sm outline-none data-highlighted:bg-muted"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{model.name || model.id}</div>
                    {model.name && model.name !== model.id && (
                      <div className="truncate text-xs text-muted-foreground">{model.id}</div>
                    )}
                  </div>
                  {model.provider && (
                    <span className="text-xs text-muted-foreground">{model.provider}</span>
                  )}
                  <Combobox.ItemIndicator>
                    <Check className="size-4 text-primary" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
