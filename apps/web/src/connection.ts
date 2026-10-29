import { useSyncExternalStore } from "react";
import {
  GatewayMessageSchema,
  type ConfigMessage,
  type GatewayStatus,
  type StateMessage,
} from "@rpp/protocol";

/** Render this far behind the newest snapshot so there is always a later sample to interpolate to. */
export const RENDER_DELAY_MS = 40;
/** Data older than this is flagged as stale in the UI. */
export const STALE_AFTER_MS = 500;
/** Snapshots kept for interpolation. */
const BUFFER_MS = 1000;

export type SocketState = "connecting" | "open" | "closed";

export interface GatewaySnapshot {
  socket: SocketState;
  status: GatewayStatus | undefined;
  config: ConfigMessage | undefined;
  protocolError: string | undefined;
}

/**
 * Connection to the gateway's WebSocket: keeps config, status and a short buffer of state snapshots.
 * Per-frame consumers read `snapshots` and `renderTime()` directly; React UI subscribes via `useGateway`.
 */
export class GatewayStore {
  snapshots: StateMessage[] = [];
  /** Local arrival time per buffered snapshot (same order as `snapshots`). */
  private arrivals: number[] = [];
  private lastArrival = 0;
  private socket: WebSocket | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryMs = 500;
  private stopped = true;
  private listeners = new Set<() => void>();
  private snapshot: GatewaySnapshot = {
    socket: "connecting",
    status: undefined,
    config: undefined,
    protocolError: undefined,
  };

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

  /** Newest buffered state, if any. */
  latest(): StateMessage | undefined {
    return this.snapshots.at(-1);
  }

  /** Milliseconds since the last state message arrived. */
  dataAge(now = performance.now()): number | undefined {
    return this.lastArrival ? now - this.lastArrival : undefined;
  }

  /**
   * Time on the PLC's tRel axis to render now, delayed by RENDER_DELAY_MS and never past the newest sample.
   * Local time is mapped to tRel with the smallest observed (arrival − tRel) over the buffer, so a late
   * arrival never pulls the clock backwards.
   */
  renderTime(now = performance.now()): number {
    const latest = this.latest();
    if (!latest) return 0;
    let offset = Infinity;
    for (let i = 0; i < this.snapshots.length; i++) offset = Math.min(offset, this.arrivals[i]! - this.snapshots[i]!.tRel);
    return Math.min(latest.tRel, now - offset - RENDER_DELAY_MS);
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
    socket.onopen = () => {
      this.retryMs = 500;
      this.update({ socket: "open" });
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.update({ socket: "closed", status: undefined });
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
    const message = parsed.data;
    switch (message.kind) {
      case "status":
        this.update({ status: message.status });
        break;
      case "config":
        // tRel restarts with every discovery; old snapshots belong to the previous timeline.
        this.snapshots = [];
        this.arrivals = [];
        this.update({ config: message, protocolError: undefined });
        break;
      case "state": {
        if (message.configVersion !== this.snapshot.config?.configVersion) break;
        this.lastArrival = performance.now();
        this.snapshots.push(message);
        this.arrivals.push(this.lastArrival);
        const oldest = message.tRel - BUFFER_MS;
        while (this.snapshots.length > 2 && this.snapshots[0]!.tRel < oldest) {
          this.snapshots.shift();
          this.arrivals.shift();
        }
        break;
      }
    }
  }
}

export function defaultGatewayUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}
export function useGateway(store: GatewayStore): GatewaySnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
