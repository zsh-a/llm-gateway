import { Network, Pencil, Power, Trash2 } from "lucide-react";
import { EmptyState, StatusBadge } from "../../components/common";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Spinner,
} from "../../components/ui";
import { cn } from "../../lib/utils";
import type { ChannelConfig } from "../../types";

export function ChannelList({
  items,
  pendingAction,
  onEdit,
  onToggle,
  onRemove,
  isBusy,
}: {
  items: ChannelConfig[];
  pendingAction: string | null;
  onEdit: (item: ChannelConfig) => void;
  onToggle: (item: ChannelConfig) => void;
  onRemove: (item: ChannelConfig) => void;
  isBusy: (action: string) => boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>渠道列表</CardTitle>
        <CardDescription>{items.length} 个已配置渠道</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 && <EmptyState icon={Network} title="暂无渠道" />}
        {items.map((item) => {
          const toggleAction = `channel-toggle:${item.id}`;
          const removeAction = `channel-remove:${item.id}`;
          const busy = Boolean(pendingAction);
          return (
            <div
              key={item.id}
              className={cn(
                "flex items-center justify-between gap-3 rounded-xl",
                "border border-border/70 bg-muted/15 px-3.5 py-3",
              )}
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Network className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{item.name || item.id}</div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {item.id} · {item.providerId} · {item.authRef}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <StatusBadge
                  status={item.enabled === false ? "offline" : "ready"}
                  label={item.enabled === false ? "停用" : "启用"}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onEdit(item)}
                  disabled={busy}
                  title="编辑渠道"
                  aria-label="编辑渠道"
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onToggle(item)}
                  disabled={busy}
                  title={item.enabled === false ? "启用渠道" : "停用渠道"}
                  aria-label={item.enabled === false ? "启用渠道" : "停用渠道"}
                >
                  {isBusy(toggleAction) ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <Power className="size-3.5" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemove(item)}
                  disabled={busy}
                  title="删除渠道"
                  aria-label="删除渠道"
                >
                  {isBusy(removeAction) ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <Trash2 className="size-3.5 text-red-300" />
                  )}
                </Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
