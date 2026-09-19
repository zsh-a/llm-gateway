import { KeyRound, Pencil, Power, Trash2 } from "lucide-react";
import { EmptyState } from "../../components/common";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Spinner,
} from "../../components/ui";
import { formatCompact } from "../../lib/format";
import { cn } from "../../lib/utils";
import type { ApiKeyRecord } from "../../types";

export function ApiKeyList({
  items,
  pendingAction,
  onEdit,
  onToggle,
  onRevoke,
  isBusy,
}: {
  items: ApiKeyRecord[];
  pendingAction: string | null;
  onEdit: (item: ApiKeyRecord) => void;
  onToggle: (item: ApiKeyRecord) => void;
  onRevoke: (item: ApiKeyRecord) => void;
  isBusy: (action: string) => boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>虚拟 API Keys</CardTitle>
        <CardDescription>{items.length} 个已管理密钥</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 && <EmptyState icon={KeyRound} title="暂无虚拟 Key" />}
        {items.map((item) => {
          const toggleAction = `key-toggle:${item.id}`;
          const removeAction = `key-remove:${item.id}`;
          const limits = [
            item.rpmLimit === null ? "RPM 不限" : `RPM ${item.rpmLimit}`,
            item.tpmLimit === null ? "TPM 不限" : `TPM ${formatCompact(item.tpmLimit)}`,
          ].join(" · ");
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
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-300">
                  <KeyRound className="size-4" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{item.name}</div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {item.prefix}… · 已用 {formatCompact(item.usedTokens)} tokens
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{limits}</div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {item.enabled ? (
                  <Badge variant="success">启用</Badge>
                ) : (
                  <Badge variant="muted">已停用</Badge>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onEdit(item)}
                  disabled={busy}
                  title="编辑 Key"
                  aria-label="编辑 Key"
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onToggle(item)}
                  disabled={busy}
                  title={item.enabled ? "停用 Key" : "启用 Key"}
                  aria-label={item.enabled ? "停用 Key" : "启用 Key"}
                >
                  {isBusy(toggleAction) ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <Power className="size-3.5" />
                  )}
                </Button>
                {item.enabled && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onRevoke(item)}
                    disabled={busy}
                    title="撤销 Key"
                    aria-label="撤销 Key"
                  >
                    {isBusy(removeAction) ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <Trash2 className="size-3.5 text-red-300" />
                    )}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
