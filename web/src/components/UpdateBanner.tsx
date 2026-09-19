import { ArrowDownToLine } from "lucide-react";
import { useState } from "react";
import {
  UpdateActions,
  UpdateProgress,
  updateMessage,
} from "../features/settings/ApplicationUpdateCard";
import type { DesktopUpdates } from "../lib/desktop-updates";
import { Button } from "./ui";

export function UpdateBanner({
  updates,
  activeRequests,
}: {
  updates: DesktopUpdates;
  activeRequests: number;
}) {
  const [dismissed, setDismissed] = useState("");
  const { status } = updates;
  if (
    !updates.native ||
    !status ||
    !["available", "downloading", "ready", "draining", "stopping", "installing"].includes(
      status.phase,
    )
  )
    return null;
  const key = `${status.version}:${status.phase}`;
  if (dismissed === key) return null;
  const canDismiss = status.phase === "available" || status.phase === "ready";
  return (
    <div
      role="status"
      className="mb-5 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <ArrowDownToLine className="size-4 shrink-0" />
          {updateMessage(status, activeRequests)}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <UpdateActions updates={updates} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              window.location.hash = "#settings?tab=updates";
            }}
          >
            详情
          </Button>
          {canDismiss && (
            <Button size="sm" variant="ghost" onClick={() => setDismissed(key)}>
              稍后提醒
            </Button>
          )}
        </div>
      </div>
      <UpdateProgress status={status} />
    </div>
  );
}
