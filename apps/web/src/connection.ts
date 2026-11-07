import { useSyncExternalStore } from "react";
import { GatewayMessageSchema, RegisterDecoder, RegisterGapError, type GatewayMessage, type StateMessage } from "@rpp/protocol";
import { METRICS_WINDOW_MS } from "./metrics";
import { ProductHistory, type ProductEvent, type ProductStep } from "./product-history";
import type { SceneSource } from "./scene/scene-model";
import { Sources, type SourceInfo } from "./sources";

/** Data older than this is flagged as stale in the UI. */
export const STALE_AFTER_MS = 500;

export type SocketState = "connecting" | "open" | "closed";

export interface GatewaySnapshot {
  socket: SocketState;
  /** In the order the gateway first reported them. */
  sources: readonly SourceInfo[];
  protocolError: string | undefined;
}

/** What the 3D view and the inspector read every frame: the live gateway or a recording being played back. */
export interface SceneFeed {
  /** Every source as the machine scene takes it, at `now` (performance.now()). */
  sceneSources(now?: number): SceneSource[];
  /** A source's newest state, e.g. for the inspector. */
  latestState(sourceId: string): StateMessage | undefined;
  /** What has happened to a product so far, and the current moment on the same clock. */
  productHistory(sourceId: string, conveyorId: number, productId: number): { steps: ProductStep[]; now: number };
  /** Product events of the last `windowMs`, the current moment and when the data starts, for the metrics. */
  productEvents(windowMs: number): { events: ProductEvent[]; now: number; since: number };
}

/** Receives every valid message from the gateway with its JSON and arrival time (performance.now()). */
export type MessageListener = (message: GatewayMessage, raw: string, arrival: number) => void;

/**
 * Connection to the gateway's WebSocket: folds its messages into `Sources` on the performance.now() axis.
 * Per-frame consumers read `sceneSources()` directly; React UI subscribes via `useGateway`.
 */
export class GatewayStore implements SceneFeed {
  private readonly sources = new Sources();
  private readonly messageListeners = new Set<MessageListener>();
  // Product events are kept a little longer than the metrics look back.
  private readonly products = new ProductHistory(undefined, 2 * METRICS_WINDOW_MS);
  /** Arrival of the first state: the metrics cover no more than the time since. */
  private firstStateAt: number | undefined;
  private socket: WebSocket | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryMs = 500;
  private stopped = true;
  private listeners = new Set<() => void>();
  private snapshot: GatewaySnapshot = { socket: "connecting", sources: [], protocolError: undefined };
  /** States arrive in register form, only the changed products listed (ADR 0013); this restores them whole. */
  private readonly registers = new RegisterDecoder();

  constructor(private readonly url: string) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = socket.onclose = socket.onmessage = null;
      socket.close();
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  /** Every source as it is now, where a recording starts. */
  recordingContext(): readonly SourceInfo[] {
    return this.sources.all;
  }

  /** Every message from now on, e.g. for recording. */
  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  latestState(sourceId: string): StateMessage | undefined {
    return this.sources.latestState(sourceId);
  }

  /** Milliseconds since the source's last state arrived; undefined before any. */
  dataAge(sourceId: string, now = performance.now()): number | undefined {
    const at = this.sources.lastStateAt(sourceId);
    return at === undefined ? undefined : now - at;
  }

  productHistory(sourceId: string, conveyorId: number, productId: number) {
    return { steps: this.products.of(sourceId, conveyorId, productId), now: performance.now() };
  }

  productEvents(windowMs: number) {
    const now = performance.now();
    return { events: this.products.events(now - windowMs, now), now, since: this.firstStateAt ?? now };
  }

  /** Every source with its config, snapshots and render time, as the machine scene takes them. */
  sceneSources(now = performance.now()): SceneSource[] {
    return this.sources.sceneSources(now);
  }

  private update(patch: Partial<GatewaySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  private connect(): void {
    this.retryTimer = undefined;
    if (this.stopped) return;
    this.update({ socket: "connecting" });
    const socket = new WebSocket(this.url);
    this.socket = socket;
    // A new connection starts with every product of each source.
    this.registers.reset();
    socket.onopen = () => {
      this.retryMs = 500;
      this.update({ socket: "open" });
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      // Recorded like the gateway's own status, so recordings show the outage too.
      for (const message of this.sources.gatewayLost()) this.dispatch(message, JSON.stringify(message));
      this.update({ socket: "closed" });
      if (this.stopped) return;
      this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.receive(String(event.data));
    };
  }

  private receive(data: string): void {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      this.update({ protocolError: "Gateway sent invalid JSON" });
      return;
    }
    const parsed = GatewayMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.update({ protocolError: parsed.error.issues[0]?.message ?? "Invalid message from gateway" });
      return;
    }
    let message = parsed.data;
    if (message.kind === "state") {
      try {
        message = this.registers.decode(message);
      } catch (error) {
        if (!(error instanceof RegisterGapError)) throw error;
        // Out of step with the gateway: a new connection starts again with every product.
        this.socket?.close();
        return;
      }
    }
    this.dispatch(message, data);
  }

  /** Hands a message to the listeners and applies it. */
  private dispatch(message: GatewayMessage, raw: string): void {
    const arrival = performance.now();
    for (const l of this.messageListeners) l(message, raw, arrival);
    const source = this.sources.apply(arrival, message);
    if (message.kind === "state") {
      if (message.configVersion !== source.config?.configVersion) return;
      this.products.add(arrival, message, source);
      this.firstStateAt ??= arrival;
      return;
    }
    this.update({
      sources: this.sources.all,
      ...(message.kind === "config" ? { protocolError: undefined } : {}),
    });
  }
}

export function defaultGatewayUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  // Only the products that changed, see ADR 0013.
  return `${protocol}//${location.host}/ws?changes=1`;
}
export function useGateway(store: GatewayStore): GatewaySnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
