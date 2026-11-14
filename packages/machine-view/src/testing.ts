import type { ClientMessage, GatewayMessage, WriteResultMessage } from "@rpp/protocol";
import type { ParameterMessage, SocketState } from "./gateway-connection";
import { GatewayLive, type LiveConnection } from "./gateway-live";
import type { SceneSource } from "./scene/scene-model";
import { Sources, type SourceInfo } from "./sources";

/**
 * The gateway's WebSocket as the apps' tests drive it (`@rpp/machine-view/testing`): messages delivered here reach a
 * `GatewayLive` like the live ones, and the commands it sends are recorded and answered.
 */
export class FakeConnection implements LiveConnection {
  private readonly sources = new Sources();
  private snapshot: { socket: SocketState; sources: readonly SourceInfo[] } = { socket: "open", sources: this.sources.all };
  private readonly listeners = new Set<() => void>();
  private readonly messageListeners = new Set<(message: GatewayMessage) => void>();
  private readonly parameterListeners = new Set<(message: ParameterMessage) => void>();
  /** When delivered messages arrive and what `frame` draws, on the performance.now() axis. */
  now = 0;
  /** Every command sent to the gateway. */
  readonly sent: ClientMessage[] = [];
  /**
   * How the gateway answers a command (asynchronously, as over the socket); by default it takes it under the next stage
   * id. Undefined: it never answers.
   */
  answer: (command: ClientMessage) => Omit<WriteResultMessage, "kind" | "requestId"> | undefined = () => ({
    ok: true,
    stageId: 100 + this.sent.length,
  });

  /** A message from the gateway. */
  deliver(message: GatewayMessage | ParameterMessage): void {
    if (message.kind === "parameters" || message.kind === "writeResult") {
      for (const l of this.parameterListeners) l(message);
      return;
    }
    this.sources.apply(this.now, message);
    for (const l of this.messageListeners) l(message);
    if (this.sources.all !== this.snapshot.sources) this.update({ sources: this.sources.all });
  }

  /** The socket closes (the gateway is lost) or opens again. */
  setSocket(socket: SocketState): void {
    this.update({ socket });
  }

  send(message: ClientMessage): boolean {
    if (this.snapshot.socket !== "open") return false;
    this.sent.push(message);
    const answer = this.answer(message);
    if (answer) queueMicrotask(() => this.deliver({ kind: "writeResult", requestId: message.requestId, ...answer }));
    return true;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  onMessage(listener: (message: GatewayMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onParameterMessage(listener: (message: ParameterMessage) => void): () => void {
    this.parameterListeners.add(listener);
    return () => this.parameterListeners.delete(listener);
  }

  frame(now = this.now): SceneSource[] {
    return this.sources.sceneSources(now);
  }

  private update(patch: Partial<typeof this.snapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }
}

/**
 * The gateway as an app's tests drive it: the real `GatewayLive` (`gateway`, what an app's seam takes) over a
 * `FakeConnection`. Messages sent here reach it like the live ones; the commands it sends are recorded and answered.
 */
export class FakeGateway {
  readonly connection = new FakeConnection();
  readonly gateway = new GatewayLive(this.connection);

  /** When messages arrive, on the performance.now() axis. */
  get now(): number {
    return this.connection.now;
  }
  set now(now: number) {
    this.connection.now = now;
  }

  /** Every command sent to the gateway. */
  get commands(): readonly ClientMessage[] {
    return this.connection.sent;
  }

  /** How the gateway answers a command; by default it takes it under the next stage id. */
  set answer(answer: (command: ClientMessage) => Omit<WriteResultMessage, "kind" | "requestId">) {
    this.connection.answer = answer;
  }

  /** A message from the gateway. */
  send(message: GatewayMessage | ParameterMessage): void {
    this.connection.deliver(message);
  }
}
