import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { ClientMessageSchema, RegisterEncoder, withRegisters, type WriteResultMessage } from "@rpp/protocol";
import type { MessageSource } from "./gateway";
import { createDocsPage, DOCS_PATH, DOCS_SCHEMA_PATH } from "./docs-page";
import { watchHealth } from "./health";
import { APP_VERSION } from "./version";

/** WebSocket path the web app connects to. */
export const WS_PATH = "/ws";
/** Health of every source as JSON; 200 while all are connected, else 503. */
export const HEALTH_PATH = "/health";
export { DOCS_PATH, DOCS_SCHEMA_PATH } from "./docs-page";

/** The answer to a command from a page of another origin. */
export const FOREIGN_ORIGIN = "Commands are taken only from the gateway's own pages.";

/**
 * Whether a WebSocket was opened by one of the gateway's own pages: a browser sends the page's origin, which must
 * name the host the socket was opened on. A client without an Origin header is no browser page (a tool, a script).
 */
function isOwnOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

/** Above this many queued bytes, state snapshots to that client are dropped until it catches up. */
const MAX_BUFFERED_BYTES = 1_000_000;

/** One WebSocket client. */
interface Client {
  socket: WebSocket;
  /** It asked for states in register form (`/ws?changes=1`). */
  changes: boolean;
  /** Sources whose previous state it got, so it can take the next one as changes. */
  synced: Set<string>;
}

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
  /** One gateway, or several combined with `combineGateways`. */
  gateway: MessageSource;
  port: number;
  host?: string;
  /** Directory with the built web app; omit to serve the WebSocket only (development with Vite). */
  staticDir?: string;
  /** Release version reported at /health; defaults to this build's. */
  version?: string;
}

/** One HTTP port serving the built web app plus the WebSocket fan-out, which takes commands on parameter sets only. */
export function startServer({ gateway, port, host, staticDir, version = APP_VERSION }: ServerOptions): Promise<Server> {
  const root = staticDir ? resolve(staticDir) : undefined;
  const health = watchHealth(gateway, version);
  const docs = createDocsPage(version);

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && pathname === HEALTH_PATH) {
      const report = health();
      res.writeHead(report.ok ? 200 : 503, { "content-type": MIME[".json"], "cache-control": "no-store" });
      res.end(JSON.stringify(report));
      return;
    }
    // The guide to the PLC library, also without a built web app (ADR 0014).
    if (req.method === "GET" && (pathname === DOCS_PATH || pathname === `${DOCS_PATH}/`)) {
      let html: string;
      try {
        html = docs.page(health());
      } catch (error) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(`Cannot build the documentation: ${(error as Error).message}`);
        return;
      }
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && pathname === DOCS_SCHEMA_PATH) {
      res.writeHead(200, { "content-type": MIME[".json"] });
      res.end(JSON.stringify(docs.schema(), null, 2));
      return;
    }
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
      // A page of the web app by its name, e.g. /configurator (ADR 0016); any other unknown path falls back to the
      // visualisation.
      const page = `${file.replace(/[\\/]+$/, "")}.html`;
      file = (await isFile(page)) ? page : join(root, "index.html");
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
  // Listen errors (e.g. port in use) are re-emitted here; the listen promise below reports them.
  wss.on("error", () => {});
  const clients = new Set<Client>();
  // States in register form for the clients that asked for changes, all from one encoder (ADR 0013).
  const encoder = new RegisterEncoder();
  // Every message is turned into JSON once per form for all clients; a new client first gets the current status and
  // config.
  gateway.subscribe((message) => {
    if (clients.size === 0) return;
    if (message.kind !== "state") {
      const json = JSON.stringify(message);
      for (const client of clients) send(client.socket, json);
      return;
    }
    const changes = [...clients].some((c) => c.changes);
    // Without such a client nothing is encoded; the next one starts with every product anyway.
    if (!changes) encoder.reset();
    const encoded = changes ? encoder.encode(message) : undefined;
    let whole: string | undefined;
    let changed: string | undefined;
    let full: string | undefined;
    for (const client of clients) {
      // A client that cannot keep up skips states; config and status always go through.
      if (client.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        // One with changes then needs every product of this source again.
        client.synced.delete(message.sourceId);
        continue;
      }
      if (!client.changes) {
        send(client.socket, (whole ??= JSON.stringify(message)));
      } else if (client.synced.has(message.sourceId)) {
        send(client.socket, (changed ??= JSON.stringify(encoded)));
      } else {
        send(client.socket, (full ??= JSON.stringify(withRegisters(message))));
        client.synced.add(message.sourceId);
      }
    }
    const sent = changed ?? whole ?? full;
    if (sent !== undefined) gateway.acquisition(message.sourceId)?.recordSent(Buffer.byteLength(sent));
  });
  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const changes = new URL(request.url ?? "/", "http://localhost").searchParams.get("changes") === "1";
    // A browser always names the page that opened the socket; one of another origin may only read (ADR 0017).
    const commandsAllowed = isOwnOrigin(request);
    // Subscribing hands over the current status and config at once; later messages come through the shared listener.
    gateway.subscribe((message) => send(socket, JSON.stringify(message)))();
    const client: Client = { socket, changes, synced: new Set() };
    clients.add(client);
    socket.on("close", () => clients.delete(client));
    // The only thing a browser may send is a command on parameter sets (ADR 0017); anything else is ignored. The
    // answer goes to this client only; whether writing is allowed at all, the gateway decides.
    socket.on("message", (data) => {
      let json: unknown;
      try {
        json = JSON.parse(String(data));
      } catch {
        return;
      }
      const parsed = ClientMessageSchema.safeParse(json);
      if (!parsed.success) return;
      const command = parsed.data;
      const answer = (result: { ok: true; stageId: number } | { ok: false; error: string }) => {
        const message: WriteResultMessage = result.ok
          ? { kind: "writeResult", requestId: command.requestId, ok: true, stageId: result.stageId }
          : { kind: "writeResult", requestId: command.requestId, ok: false, error: result.error };
        send(socket, JSON.stringify(message));
      };
      if (!commandsAllowed) {
        answer({ ok: false, error: FOREIGN_ORIGIN });
        return;
      }
      gateway
        .command(command)
        .then(answer)
        .catch((error: unknown) => answer({ ok: false, error: `The command failed: ${error instanceof Error ? error.message : String(error)}` }));
    });
  });

  function send(socket: WebSocket, json: string): void {
    if (socket.readyState === socket.OPEN) socket.send(json);
  }

  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => done(server));
  });
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
