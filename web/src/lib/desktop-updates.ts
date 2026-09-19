import type { UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import {
  cancelUpdate,
  getUpdateStatus,
  listenUpdateStatus,
  runUpdateAction,
  type UpdateAction,
  type UpdateStatus,
} from "../app-updates";
import { isTauriRuntime } from "../remote-sync";
import type { NoticeTone } from "../types";
import { queryErrorMessage } from "./query";

export function useDesktopUpdates(onNotice: (message: string, tone?: NoticeTone) => void) {
  const native = isTauriRuntime();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let eventRevision = revision;
    let snapshotRevision = revision;
    let cleanup: UnlistenFn | undefined;
    setError("");
    void (async () => {
      try {
        cleanup = await listenUpdateStatus((next) => {
          eventRevision += 1;
          if (!disposed) {
            setStatus(next);
            setError("");
          }
        });
        if (disposed) {
          cleanup();
          return;
        }
        snapshotRevision = eventRevision;
        const current = await getUpdateStatus();
        if (!disposed && eventRevision === snapshotRevision) setStatus(current);
      } catch (cause) {
        if (!disposed && eventRevision === snapshotRevision)
          setError(queryErrorMessage(cause, "读取更新状态失败"));
      }
    })();
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [native, revision]);

  const run = useCallback(
    async (action: UpdateAction) => {
      setPending(true);
      try {
        await runUpdateAction(action);
      } catch (cause) {
        onNotice(queryErrorMessage(cause, "更新操作失败"), "error");
      } finally {
        setPending(false);
      }
    },
    [onNotice],
  );
  const cancel = useCallback(async () => {
    try {
      await cancelUpdate();
    } catch (cause) {
      onNotice(queryErrorMessage(cause, "取消更新失败"), "error");
    }
  }, [onNotice]);
  return {
    native,
    status,
    error,
    pending,
    run,
    cancel,
    retry: () => setRevision((value) => value + 1),
  };
}

export type DesktopUpdates = ReturnType<typeof useDesktopUpdates>;
