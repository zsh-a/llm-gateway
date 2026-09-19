import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { isTauriRuntime } from "../remote-sync";
import {
  controlService,
  forceQuit,
  getServiceStatus,
  listenServiceStatus,
  type ServiceStatus,
} from "../service-settings";
import type { NoticeTone } from "../types";
import { queryErrorMessage } from "./query";

export function useDesktopService(onNotice: (message: string, tone?: NoticeTone) => void) {
  const native = isTauriRuntime();
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let eventRevision = revision;
    let snapshotRevision = eventRevision;
    const cleanups: UnlistenFn[] = [];
    const retain = (cleanup: UnlistenFn) => {
      if (disposed) cleanup();
      else cleanups.push(cleanup);
    };
    setError("");
    void (async () => {
      try {
        // Subscribe before fetching the snapshot, and never overwrite a newer event.
        retain(
          await listenServiceStatus((next) => {
            eventRevision += 1;
            if (!disposed) {
              setStatus(next);
              setError("");
            }
          }),
        );
        if (disposed) return;
        snapshotRevision = eventRevision;
        const current = await getServiceStatus();
        if (!disposed && snapshotRevision === eventRevision) setStatus(current);
      } catch (error) {
        if (!disposed && snapshotRevision === eventRevision)
          setError(queryErrorMessage(error, "读取本机服务状态失败"));
      }
    })();
    void listen<{ message: string; tone: NoticeTone }>("desktop-notice", ({ payload }) => {
      if (!disposed) onNotice(payload.message, payload.tone);
    })
      .then(retain)
      .catch((error) => {
        if (!disposed) onNotice(queryErrorMessage(error, "无法接收桌面通知"), "error");
      });
    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, [native, onNotice, revision]);

  const control = useCallback(
    async (action: "start" | "stop" | "restart") => {
      setBusy(true);
      try {
        await controlService(action);
      } catch (error) {
        onNotice(queryErrorMessage(error, "服务操作失败"), "error");
      } finally {
        setBusy(false);
      }
    },
    [onNotice],
  );
  const force = useCallback(async () => {
    try {
      await forceQuit();
    } catch (error) {
      onNotice(queryErrorMessage(error, "退出失败"), "error");
    }
  }, [onNotice]);
  return {
    native,
    status,
    error,
    busy,
    control,
    force,
    retry: () => setRevision((value) => value + 1),
  };
}

export type DesktopService = ReturnType<typeof useDesktopService>;
