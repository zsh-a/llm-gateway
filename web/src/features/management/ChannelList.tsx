import { Network } from "lucide-react";
import { EmptyState } from "../../components/common";
import { ResourceActions } from "../../components/ResourceActions";
import type { ChannelConfig } from "../../types";

export function ChannelList({
  items,
  disabled,
  onEdit,
  onToggle,
  onRemove,
}: {
  items: ChannelConfig[];
  disabled: boolean;
  onEdit: (item: ChannelConfig) => void;
  onToggle: (item: ChannelConfig) => void;
  onRemove: (item: ChannelConfig) => void;
}) {
  if (!items.length)
    return (
      <EmptyState
        icon={Network}
        title="还没有渠道"
        description="点击“新增渠道”，连接一个 Provider。"
      />
    );
  return (
    <div className="divide-y rounded-xl border bg-card">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{item.name || item.id}</div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{item.providerId}</span>
              <span className="font-mono">{item.id}</span>
              {item.authRef !== item.providerId && <span>认证：{item.authRef}</span>}
              <span>
                优先级 {item.priority ?? 100} · 权重 {item.weight ?? 1}
              </span>
            </div>
          </div>
          <ResourceActions
            name={item.name || item.id}
            enabled={item.enabled !== false}
            disabled={disabled}
            onEdit={() => onEdit(item)}
            onToggle={() => onToggle(item)}
            onRemove={() => onRemove(item)}
            removeLabel="删除渠道"
          />
        </div>
      ))}
    </div>
  );
}
