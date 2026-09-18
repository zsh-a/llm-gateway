import type { ServerType } from "@hono/node-server";
import type { Server } from "node:http";

/** Stop admitting requests, allow active streams to finish, and flush even if
 * a stuck connection reaches the deadline. The caller exits after completion. */
export function closeGatewayServer(
  server: ServerType,
  flush: () => void,
  timeoutMs = 10_000
): Promise<boolean> {
  const httpServer = server as Server;
  return new Promise((resolve, reject) => {
    let finished = false;
    function complete(graceful: boolean): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(reapIdle);
      try { flush(); resolve(graceful); } catch (error) { reject(error); }
    }
    const timer = setTimeout(() => {
      httpServer.closeAllConnections?.();
      complete(false);
    }, timeoutMs);
    // Connections that were active at close() can become idle afterward.
    const reapIdle = setInterval(() => httpServer.closeIdleConnections?.(), 100);
    server.close(() => complete(true));
    httpServer.closeIdleConnections?.();
  });
}
