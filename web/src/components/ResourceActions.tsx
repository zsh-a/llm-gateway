import { Menu } from "@base-ui/react/menu";
import { Switch } from "@base-ui/react/switch";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "./ui";

export function ResourceActions({
  name,
  enabled,
  disabled,
  onEdit,
  onToggle,
  onRemove,
  removeLabel = "删除",
}: {
  name: string;
  enabled: boolean;
  disabled?: boolean;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
  removeLabel?: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <Switch.Root
        checked={enabled}
        onCheckedChange={onToggle}
        disabled={disabled}
        aria-label={`${enabled ? "停用" : "启用"} ${name}`}
        className="inline-flex h-5 w-9 items-center rounded-full bg-input p-0.5 transition-colors data-checked:bg-primary disabled:opacity-50"
      >
        <Switch.Thumb className="size-4 rounded-full bg-white shadow-sm transition-transform data-checked:translate-x-4" />
      </Switch.Root>
      <Button
        variant="ghost"
        size="icon"
        onClick={onEdit}
        disabled={disabled}
        aria-label={`编辑 ${name}`}
        title="编辑"
      >
        <Pencil className="size-4" />
      </Button>
      <Menu.Root>
        <Menu.Trigger
          render={
            <Button
              variant="ghost"
              size="icon"
              disabled={disabled}
              aria-label={`${name} 的更多操作`}
            />
          }
        >
          <MoreHorizontal className="size-4" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={4} align="end" className="z-50">
            <Menu.Popup className="min-w-36 rounded-lg border bg-popover p-1 text-sm shadow-lg">
              <Menu.Item
                onClick={onRemove}
                className="flex items-center gap-2 rounded-md px-3 py-2 text-destructive outline-none data-highlighted:bg-destructive/10"
              >
                <Trash2 className="size-4" />
                {removeLabel}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
