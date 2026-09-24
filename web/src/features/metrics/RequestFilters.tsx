import { useEffect, useState } from "react";
import { Field } from "../../components/common";
import { Button, Input, Select } from "../../components/ui";
import type { MetricsQuery } from "../../types";

export function RequestFilters({
  filters,
  onChange,
}: {
  filters: MetricsQuery;
  onChange: (next: Partial<MetricsQuery>) => void;
}) {
  const [requestId, setRequestId] = useState(filters.requestId ?? "");
  useEffect(() => setRequestId(filters.requestId ?? ""), [filters.requestId]);
  return (
    <form
      className="mb-4 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onChange({ requestId: requestId.trim() || undefined });
      }}
    >
      <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto]">
        <Field label="Request ID" htmlFor="request-id-filter">
          <Input
            id="request-id-filter"
            value={requestId}
            onChange={(event) => setRequestId(event.target.value)}
            placeholder="粘贴完整 Request ID"
          />
        </Field>
        <Field label="结束原因" htmlFor="request-finish-filter">
          <Select
            id="request-finish-filter"
            value={filters.finishReason ?? ""}
            onChange={(event) => onChange({ finishReason: event.target.value || undefined })}
          >
            <option value="">全部结束原因</option>
            <option value="length">达到输出上限</option>
            <option value="content_filter">内容过滤</option>
            <option value="stop">正常结束</option>
            <option value="tool_calls">工具调用</option>
          </Select>
        </Field>
        <Button type="submit" variant="outline">
          查找请求
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>以上条件仅筛选保留的请求明细；汇总与趋势不变。</span>
        {(filters.requestId || filters.finishReason) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setRequestId("");
              onChange({ requestId: undefined, finishReason: undefined });
            }}
          >
            清除明细筛选
          </Button>
        )}
      </div>
    </form>
  );
}
