import { useSyncExternalStore } from "react";
import {
  RegisterDecoder,
  RegisterGapError,
  ServerMessageSchema,
  type ClientMessage,
  type GatewayMessage,
  type ParametersMessage,
  type StateMessage,
  type WriteResultMessage,
} from "@rpp/protocol";
import type { SceneSource } from "./scene/scene-model";
import { Sources, type SourceInfo } from "./sources";

/** Data older than this is flagged as stale in the UI. */
export const STALE_AFTER_MS = 500;

export type SocketState = "connecting" | "open" | "closed";

export interface ConnectionSnapshot {
  socket: SocketState;
  /** In the order the gateway first reported them. */
  sources: readonly SourceInfo[];
  protocolError: string | undefined;
}

/**
 * Receives every machine message (status, config, state) once it is applied to the sources, with its JSON, its arrival
 * time (performance.now()) and its source as it is after the message.
 */
export type MessageListener = (message: GatewayMessage, raw: string, arrival: number, source: SourceInfo | undefined) => void;

/** The messages on parameter sets (ADR 0017): never part of the sources, never recorded. */
export type ParameterMessage = ParametersMessage | WriteResultMessage;

/**
 * The connection to the gateway's WebSocket, shared by both pages: it reconnects, restores states from register form
 * (ADR 0013) and folds the machine messages into `Sources` on the performance.now() axis. What a page makes of the
 * messages beyond that (product history, parameter sets) it builds on `onMessage` and `onParameterMessage`. Per-frame
 * consumers call `frame()`; React UI subscribes via `useStore`.
 */
export class GatewayConnection {
  private readonly sources = new Sources();
  private readonly messageListeners = new Set<MessageListener>();
  private readonly parameterListeners = new Set<(message: ParameterMessage) => void>();
  private socket: WebSocket | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryMs = 500;
  private stopped = true;
  private listeners = new Set<() => void>();
  private snapshot: ConnectionSnapshot = { socket: "connecting", sources: [], protocolError: undefined };
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

  /** Every machine message from now on. */
  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  /** Every message on parameter sets from now on. */
  onParameterMessage(listener: (message: ParameterMessage) => void): () => void {
    this.parameterListeners.add(listener);
    return () => this.parameterListeners.delete(listener);
  }

  /** Sends a command to the gateway; false when it is not connected. */
  send(message: ClientMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  latestState(sourceId: string): StateMessage | undefined {
    return this.sources.latestState(sourceId);
  }

  /** Milliseconds since the source's last state arrived; undefined before any. */
  dataAge(sourceId: string, now = performance.now()): number | undefined {
    const at = this.sources.lastStateAt(sourceId);
    return at === undefined ? undefined : now - at;
  }

  /** Every source with its config, snapshots and render time, as the machine scene takes them. */
  frame(now = performance.now()): SceneSource[] {
    return this.sources.sceneSources(now);
  }

  private update(patch: Partial<ConnectionSnapshot>): void {
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
      // Handed on like the gateway's own status, so recordings show the outage too.
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
    const parsed = ServerMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.update({ protocolError: parsed.error.issues[0]?.message ?? "Invalid message from gateway" });
      return;
    }
    if (parsed.data.kind === "parameters" || parsed.data.kind === "writeResult") {
      for (const l of this.parameterListeners) l(parsed.data);
      return;
    }
    let message: GatewayMessage = parsed.data;
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

  /** Applies a message and hands it to the listeners. */
  private dispatch(message: GatewayMessage, raw: string): void {
    const arrival = performance.now();
    const source = this.sources.apply(arrival, message);
    if (message.kind !== "state") {
      this.update({ sources: this.sources.all, ...(message.kind === "config" ? { protocolError: undefined } : {}) });
    }
    for (const l of this.messageListeners) l(message, raw, arrival, source);
  }
}

/** The gateway that served the page, asked for only the products that changed (ADR 0013). */
export function defaultGatewayUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws?changes=1`;
}

/** A store's snapshot in a React component, re-rendered when it changes. */
export function useStore<T>(store: { subscribe(listener: () => void): () => void; getSnapshot(): T }): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
