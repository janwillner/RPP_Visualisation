import { useSyncExternalStore } from "react";
import {
  GatewayMessageSchema,
  type ConfigMessage,
  type GatewayMessage,
  type GatewayStatus,
  type StateMessage,
} from "@rpp/protocol";
import { ProductHistory, type ProductStep } from "./product-history";
import type { SceneSource } from "./scene/scene-model";

/** Render this far behind the newest snapshot so there is always a later sample to interpolate to. */
export const RENDER_DELAY_MS = 40;
/** Data older than this is flagged as stale in the UI. */
export const STALE_AFTER_MS = 500;
/** Snapshots kept for interpolation. */
const BUFFER_MS = 1000;

export type SocketState = "connecting" | "open" | "closed";

/** What the UI knows about one PLC source. */
export interface SourceInfo {
  sourceId: string;
  name: string;
  /** Undefined while the gateway connection is down. */
  status: GatewayStatus | undefined;
  /** The last config, kept while the source is offline. */
  config: ConfigMessage | undefined;
}

/** Whether the gateway currently reads this source's PLC (false for all while the gateway connection is down). */
export function isOnline(snapshot: GatewaySnapshot, source: SourceInfo): boolean {
  return snapshot.socket === "open" && source.status?.plcConnected === true;
}

export interface GatewaySnapshot {
  socket: SocketState;
  /** In the order the gateway first reported them. */
  sources: SourceInfo[];
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
}

/** Receives every valid message from the gateway with its JSON and arrival time (performance.now()). */
export type MessageListener = (message: GatewayMessage, raw: string, arrival: number) => void;

/** Snapshot buffer and clock of one source; every source has its own tRel axis. */
export class SourceBuffer {
  snapshots: StateMessage[] = [];
  /** Local arrival time per buffered snapshot (same order as `snapshots`). */
  private arrivals: number[] = [];
  private lastArrival = 0;

  /** Newest buffered state, if any. */
  latest(): StateMessage | undefined {
    return this.snapshots.at(-1);
  }

  /** Milliseconds since the last state message arrived. */
  dataAge(now = performance.now()): number | undefined {
    return this.lastArrival ? now - this.lastArrival : undefined;
  }

  /**
   * Time on the source's tRel axis to render now, delayed by RENDER_DELAY_MS and never past the newest sample.
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

  clear(): void {
    this.snapshots = [];
    this.arrivals = [];
  }

  push(message: StateMessage): void {
    // tRel restarts when the gateway rediscovers (e.g. after a reconnect): drop the old timeline.
    if (message.tRel < (this.latest()?.tRel ?? -Infinity)) this.clear();
    this.lastArrival = performance.now();
    this.snapshots.push(message);
    this.arrivals.push(this.lastArrival);
    const oldest = message.tRel - BUFFER_MS;
    while (this.snapshots.length > 2 && this.snapshots[0]!.tRel < oldest) {
      this.snapshots.shift();
      this.arrivals.shift();
    }
  }
}

/**
 * Connection to the gateway's WebSocket: keeps config, status and a short buffer of state snapshots per PLC source.
 * Per-frame consumers read `buffer(sourceId)` and `sceneSources()` directly; React UI subscribes via `useGateway`.
 */
export class GatewayStore implements SceneFeed {
  private readonly buffers = new Map<string, SourceBuffer>();
  private readonly messageListeners = new Set<MessageListener>();
  private readonly products = new ProductHistory();
  private socket: WebSocket | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryMs = 500;
  private stopped = true;
  private listeners = new Set<() => void>();
  private snapshot: GatewaySnapshot = { socket: "connecting", sources: [], protocolError: undefined };

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
  recordingContext(): SourceInfo[] {
    return this.snapshot.sources.map((s) => ({ ...s }));
  }

  /** Every message from now on, e.g. for recording. */
  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  latestState(sourceId: string): StateMessage | undefined {
    return this.buffer(sourceId).latest();
  }

  productHistory(sourceId: string, conveyorId: number, productId: number) {
    return { steps: this.products.of(sourceId, conveyorId, productId), now: performance.now() };
  }

  /** The snapshot buffer of a source; empty for an unknown one. */
  buffer(sourceId: string): SourceBuffer {
    let buffer = this.buffers.get(sourceId);
    if (!buffer) this.buffers.set(sourceId, (buffer = new SourceBuffer()));
    return buffer;
  }

  /** Every source with its config, snapshots and render time, as the machine scene takes them. */
  sceneSources(now = performance.now()): SceneSource[] {
    return this.snapshot.sources.map((s) => {
      const buffer = this.buffer(s.sourceId);
      return {
        sourceId: s.sourceId,
        config: s.config,
        snapshots: buffer.snapshots,
        renderTime: buffer.renderTime(now),
        online: isOnline(this.snapshot, s),
      };
    });
  }

  private update(patch: Partial<GatewaySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  /** Replaces one source's info, adding the source when it is new. */
  private updateSource(sourceId: string, patch: Partial<SourceInfo>): void {
    const sources = [...this.snapshot.sources];
    const i = sources.findIndex((s) => s.sourceId === sourceId);
    const current = sources[i] ?? { sourceId, name: sourceId, status: undefined, config: undefined };
    if (i < 0) sources.push({ ...current, ...patch });
    else sources[i] = { ...current, ...patch };
    this.update({ sources });
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
      this.update({ socket: "closed", sources: this.snapshot.sources.map((s) => ({ ...s, status: undefined })) });
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
    const arrival = performance.now();
    for (const l of this.messageListeners) l(message, data, arrival);
    const source = this.snapshot.sources.find((s) => s.sourceId === message.sourceId);
    switch (message.kind) {
      case "status":
        this.updateSource(message.sourceId, { name: message.sourceName, status: message.status });
        break;
      case "config":
        // A new config version starts a new timeline; a refreshed config of the same version does not.
        if (message.configVersion !== source?.config?.configVersion) this.buffer(message.sourceId).clear();
        this.updateSource(message.sourceId, { config: message });
        this.update({ protocolError: undefined });
        break;
      case "state":
        if (message.configVersion !== source?.config?.configVersion) break;
        this.buffer(message.sourceId).push(message);
        this.products.add(arrival, message, source);
        break;
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
