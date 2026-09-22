import { KeyRound } from "lucide-react";
import { EmptyState } from "../../components/common";
import { ResourceActions } from "../../components/ResourceActions";
import { Badge, Button } from "../../components/ui";
import { formatCompact } from "../../lib/format";
import type { ApiKeyRecord } from "../../types";
import { keyStatus } from "../metrics/KeyUsageTable";

export function ApiKeyList({
  items,
  disabled,
  onEdit,
  onToggle,
  onRevoke,
  onUsage,
}: {
  onUsage?: (id: string) => void;
  items: ApiKeyRecord[];
  disabled: boolean;
  onEdit: (item: ApiKeyRecord) => void;
  onToggle: (item: ApiKeyRecord) => void;
  onRevoke: (item: ApiKeyRecord) => void;
}) {
  if (!items.length)
    return (
      <EmptyState
        icon={KeyRound}
        title="还没有 API Key"
        description="创建独立密钥，为客户端分配模型权限和用量限额。"
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
            <div className="truncate text-sm font-medium">{item.name}</div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="font-mono">{item.prefix}…</span>
              <span>
                {item.allowedModels.length ? `${item.allowedModels.length} 个模型` : "全部模型"}
              </span>
              <span>
                已用 {formatCompact(item.usedTokens)} tokens
                {item.quotaTokens !== null ? ` / ${formatCompact(item.quotaTokens)}` : ""}
              </span>
              {(item.rpmLimit || item.tpmLimit) && (
                <span>
                  {item.rpmLimit ? `RPM ${item.rpmLimit}` : ""}{" "}
                  {item.tpmLimit ? `TPM ${formatCompact(item.tpmLimit)}` : ""}
                </span>
              )}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => onUsage?.(item.id)}>
            查看用量
          </Button>
          <Badge variant="muted">{keyStatus(item)}</Badge>
          {!item.revokedAt && (
            <ResourceActions
              name={item.name}
              enabled={item.enabled}
              disabled={disabled}
              onEdit={() => onEdit(item)}
              onToggle={() => onToggle(item)}
              onRemove={() => onRevoke(item)}
              removeLabel="撤销 Key"
            />
          )}
        </div>
      ))}
    </div>
  );
}
