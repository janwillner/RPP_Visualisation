import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { Gateway } from "./gateway";

/** WebSocket path the web app connects to. */
export const WS_PATH = "/ws";

/** Above this many queued bytes, state snapshots to that client are dropped until it catches up. */
const MAX_BUFFERED_BYTES = 1_000_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface ServerOptions {
  gateway: Gateway;
  port: number;
  host?: string;
  /** Directory with the built web app; omit to serve the WebSocket only (development with Vite). */
  staticDir?: string;
}

/** One HTTP port serving the built web app plus the read-only WebSocket fan-out. */
export function startServer({ gateway, port, host, staticDir }: ServerOptions): Promise<Server> {
  const root = staticDir ? resolve(staticDir) : undefined;

  const server = createServer((req, res) => {
    serveStatic(req.url ?? "/", res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function serveStatic(url: string, res: import("node:http").ServerResponse): Promise<void> {
    if (!root) {
      res.writeHead(404).end("No static directory configured");
      return;
    }
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(url, "http://localhost").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = normalize(join(root, urlPath));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    } catch {
      // Unknown paths fall back to the single-page app.
      file = join(root, "index.html");
    }
    try {
      await stat(file);
    } catch {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
  }

  const wss = new WebSocketServer({ server, path: WS_PATH });
  wss.on("connection", (socket: WebSocket) => {
    const unsubscribe = gateway.subscribe((message) => {
      if (socket.readyState !== socket.OPEN) return;
      // A client that cannot keep up skips state snapshots; config and status always go through.
      if (message.kind === "state" && socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
      socket.send(JSON.stringify(message));
    });
    socket.on("close", unsubscribe);
    // Read-only: anything the browser sends is ignored.
  });

  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => done(server));
  });
}
