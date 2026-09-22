import { useState } from "react";
import { Badge, Button, Input, Select } from "../../components/ui";
import { formatCompact, formatNumber, formatTime } from "../../lib/format";
import type { ApiKeyRecord, KeyUsage } from "../../types";

export function keyStatus(key: ApiKeyRecord): string {
  if (key.revokedAt) return "已撤销";
  if (key.readOnly) return "历史 / 系统";
  if (key.expiresAt && key.expiresAt <= Date.now()) return "已过期";
  return key.enabled ? "启用" : "停用";
}

export function KeyUsageTable({
  items,
  onSelect,
  onManage,
}: {
  items: KeyUsage[];
  onSelect: (id: string) => void;
  onManage: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("tokens");
  const visible = items
    .filter(
      ({ key }) =>
        (!status || keyStatus(key) === status) &&
        `${key.name} ${key.prefix} ${key.id}`.toLowerCase().includes(search.trim().toLowerCase()),
    )
    .sort((a, b) => {
      const score = (item: KeyUsage) =>
        sort === "errors"
          ? item.usage.errors
          : sort === "requests"
            ? item.usage.requests
            : sort === "recent"
              ? (item.key.lastUsedAt ?? 0)
              : (item.usage.tokens.totalTokens ?? -1);
      return score(b) - score(a) || a.key.name.localeCompare(b.key.name);
    });
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_10rem]">
        <Input
          className="min-w-0"
          aria-label="搜索 Key"
          placeholder="搜索名称、用途或 Key 前缀"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          aria-label="Key 状态"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">全部状态</option>
          {["启用", "停用", "已过期", "已撤销", "历史 / 系统"].map((state) => (
            <option key={state}>{state}</option>
          ))}
        </Select>
        <Select
          aria-label="Key 排序"
          value={sort}
          onChange={(event) => setSort(event.target.value)}
        >
          <option value="tokens">按 Token 用量</option>
          <option value="requests">按请求数</option>
          <option value="errors">按失败数</option>
          <option value="recent">按最近使用</option>
        </Select>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full whitespace-nowrap text-left text-sm" aria-label="Key 用量">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              {[
                "Key",
                "状态",
                "请求 / 失败",
                "输入 / 输出 Token",
                "成功率",
                "累计已用 / 配额",
                "最后使用",
                "进行中",
                "操作",
              ].map((label) => (
                <th key={label} scope="col" className="px-3 py-3 font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {visible.map(({ key, usage, activeRequests }) => (
              <tr key={key.id} className="hover:bg-muted/20">
                <td className="px-3 py-3">
                  <button
                    type="button"
                    onClick={() => onSelect(key.id)}
                    className="text-left font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {key.name}
                  </button>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">
                    {key.prefix ? `${key.prefix}…` : key.id}
                  </div>
                </td>
                <td className="px-3 py-3">
                  <Badge variant="muted">{keyStatus(key)}</Badge>
                </td>
                <td className="px-3 py-3">
                  {formatNumber(usage.requests)} / {formatNumber(usage.errors)}
                </td>
                <td className="px-3 py-3">
                  {usage.requests
                    ? `${usage.tokens.inputTokens === undefined ? "未知" : formatCompact(usage.tokens.inputTokens)} / ${usage.tokens.outputTokens === undefined ? "未知" : formatCompact(usage.tokens.outputTokens)}`
                    : "—"}
                  {Number(usage.tokens.requestsWithoutUsage) > 0 && (
                    <div className="mt-1 text-xs text-warning">
                      {String(usage.tokens.requestsWithoutUsage)} 次用量未知
                    </div>
                  )}
                </td>
                <td className="px-3 py-3">
                  {usage.successRate === null ? "—" : `${(usage.successRate * 100).toFixed(1)}%`}
                </td>
                <td className="px-3 py-3">
                  {key.readOnly
                    ? "—"
                    : `${formatCompact(key.usedTokens)} / ${key.quotaTokens == null ? "不限" : formatCompact(key.quotaTokens)}`}
                  {!key.readOnly && key.quotaTokens != null && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      剩余{" "}
                      {formatCompact(
                        Math.max(0, key.remainingTokens ?? key.quotaTokens - key.usedTokens),
                      )}
                    </div>
                  )}
                </td>
                <td className="px-3 py-3 text-xs">
                  {formatTime(key.lastUsedAt ?? undefined, true)}
                </td>
                <td className="px-3 py-3">{activeRequests}</td>
                <td className="px-3 py-3">
                  <Button variant="ghost" size="sm" onClick={() => onSelect(key.id)}>
                    详情
                  </Button>
                  {!key.readOnly && !key.revokedAt && (
                    <Button variant="ghost" size="sm" onClick={() => onManage(key.id)}>
                      管理
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && (
          <p className="p-6 text-center text-sm text-muted-foreground">没有符合条件的 Key</p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        请求与 Token 按所选时间范围统计；累计已用和配额为 Key 的累计值。点击名称查看该 Key
        的趋势和请求明细。
      </p>
    </div>
  );
}
