import type { ClientMessage, GatewayMessage, ParametersMessage, WriteResultMessage } from "@rpp/protocol";
import type { ConnectionSnapshot, ParameterMessage } from "./gateway-connection";
import { componentKey, type SceneSource } from "./scene/scene-model";
import type { SourceInfo } from "./sources";

/** A command on parameter sets, the recipe or the machine, as a page stages it: the request id is GatewayLive's. */
export type LiveCommand = ClientMessage extends infer C ? (C extends ClientMessage ? Omit<C, "requestId"> : never) : never;

/** How a staged write fares, from the gateway's answer until the PLC (or for a machine command, its application) handled it. */
export type TrackedWrite = { kind: LiveCommand["kind"] } & (
  | { state: "staged" | "waiting" | "applied"; stageId: number }
  | { state: "rejected"; stageId: number; message: string }
  | { state: "failed"; message: string }
);

/** The sources, per source whose PLC has Syn_Config its parameter sets and recipe, and the writes staged on them. */
export type LiveSnapshot = {
  sources: readonly SourceInfo[];
  parameters: Readonly<Record<string, ParametersMessage>>;
  /** The last write of each target (`writeKey`). */
  writes: Readonly<Record<string, TrackedWrite>>;
};

/** The connection as GatewayLive reads it: `GatewayConnection` in the apps, `FakeConnection` in tests. */
export interface LiveConnection {
  getSnapshot(): Pick<ConnectionSnapshot, "socket" | "sources">;
  subscribe(listener: () => void): () => void;
  onMessage(listener: (message: GatewayMessage) => void): () => void;
  onParameterMessage(listener: (message: ParameterMessage) => void): () => void;
  send(message: ClientMessage): boolean;
  frame(now?: number): SceneSource[];
}

/** A command not answered within this time counts as failed. */
const COMMAND_TIMEOUT_MS = 10_000;

/**
 * What a write is about, so a later write of the same target replaces it: a component's parameter set (its component
 * key), a source's recipe (write and reset alike) or a source's machine commands.
 */
export function writeKey(target: { kind: LiveCommand["kind"]; sourceId: string; componentId?: number }): string {
  switch (target.kind) {
    case "writeParameters":
    case "resetParameters":
      return componentKey(target.sourceId, target.componentId ?? 0);
    case "writeRecipe":
    case "resetRecipe":
      return `${target.sourceId}#recipe`;
    case "machineCommand":
      return `${target.sourceId}#command`;
  }
}

/**
 * The gateway as the configurator and the Simulator read and write it (ADR 0016, 0017, 0022): the connection's sources
 * plus, per source, its PLC's parameter sets and recipe, and the writes staged on them (`stage`), each followed through
 * the `parameters` messages until the PLC handled it.
 */
export class GatewayLive {
  private snapshot: LiveSnapshot;
  private readonly listeners = new Set<() => void>();
  /** Commands sent and waiting for their `writeResult`, by the request id given here (unique on this connection). */
  private readonly answers = new Map<number, (answer: WriteResultMessage) => void>();
  private nextRequest = 1;

  constructor(private readonly connection: LiveConnection) {
    this.snapshot = { sources: connection.getSnapshot().sources, parameters: {}, writes: {} };
    let socket = connection.getSnapshot().socket;
    connection.subscribe(() => {
      const now = connection.getSnapshot();
      if (now.socket === "closed" && socket !== "closed") this.lost();
      socket = now.socket;
      if (now.sources !== this.snapshot.sources) this.update({ sources: now.sources });
    });
    connection.onMessage((message) => {
      // After a new config the source's parameter sets come again, or never when its PLC has no Syn_Config any more.
      if (message.kind === "config" && message.sourceId in this.snapshot.parameters) {
        const { [message.sourceId]: _dropped, ...rest } = this.snapshot.parameters;
        this.update({ parameters: rest });
      }
    });
    connection.onParameterMessage((message) => {
      if (message.kind === "parameters") {
        const parameters = { ...this.snapshot.parameters, [message.sourceId]: message };
        this.update({ parameters, writes: followWrites(this.snapshot.writes, parameters) });
      } else {
        this.answers.get(message.requestId)?.(message);
      }
    });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  frame(now?: number): SceneSource[] {
    return this.connection.frame(now);
  }

  /**
   * Sends a write to the gateway and gives how it fares once the gateway answered: staged (then followed in `writes`
   * until the PLC handled it), or failed when the gateway refused it, did not answer within 10 s or is not connected.
   */
  async stage(command: LiveCommand): Promise<TrackedWrite> {
    const answer = await this.send(command);
    const key = writeKey(command as { kind: LiveCommand["kind"]; sourceId: string; componentId?: number });
    const write: TrackedWrite =
      answer.ok && answer.stageId !== undefined
        ? { kind: command.kind, state: "staged", stageId: answer.stageId }
        : { kind: command.kind, state: "failed", message: answer.error ?? "The gateway refused the command." };
    const writes = followWrites({ ...this.snapshot.writes, [key]: write }, this.snapshot.parameters);
    this.update({ writes });
    return writes[key]!;
  }

  private send(command: LiveCommand): Promise<WriteResultMessage> {
    const id = this.nextRequest++;
    return new Promise((resolve) => {
      const finish = (answer: WriteResultMessage) => {
        clearTimeout(timer);
        this.answers.delete(id);
        resolve(answer);
      };
      // A gateway that ignores the command (too old, or it found the command invalid) never answers.
      const timer = setTimeout(
        () => finish({ kind: "writeResult", requestId: id, ok: false, error: "The gateway did not answer the command." }),
        COMMAND_TIMEOUT_MS,
      );
      this.answers.set(id, finish);
      if (!this.connection.send({ ...command, requestId: id } as ClientMessage)) {
        finish({ kind: "writeResult", requestId: id, ok: false, error: "Not connected to the gateway." });
      }
    });
  }

  /**
   * A lost connection answers no command still waiting, and leaves open whether a staged write was taken over: it
   * fails, and the parameter sets come again with the next connection.
   */
  private lost(): void {
    for (const [requestId, answer] of [...this.answers]) {
      answer({ kind: "writeResult", requestId, ok: false, error: "The connection to the gateway was lost; the command may not have arrived." });
    }
    const writes = Object.fromEntries(
      Object.entries(this.snapshot.writes).map(([key, w]): [string, TrackedWrite] =>
        w.state === "staged" || w.state === "waiting"
          ? [key, { kind: w.kind, state: "failed", message: "The connection to the gateway was lost before the PLC answered; check its active version." }]
          : [key, w],
      ),
    );
    this.update({ parameters: {}, writes });
  }

  private update(patch: Partial<LiveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }
}

/**
 * The writes after a new `parameters` message: one the PLC handled (its stage id, or for a machine command its command
 * id, is the last handled) is applied or rejected; one still staged while the PLC reports a pending set waits.
 */
function followWrites(
  writes: Readonly<Record<string, TrackedWrite>>,
  parameters: Readonly<Record<string, ParametersMessage>>,
): Record<string, TrackedWrite> {
  const next: Record<string, TrackedWrite> = {};
  for (const [key, write] of Object.entries(writes)) {
    next[key] = write;
    if (write.state !== "staged" && write.state !== "waiting") continue;
    const status = statusOf(key, write.kind, parameters);
    if (!status) continue;
    if (status.handled === write.stageId) {
      next[key] =
        status.result === "rejected"
          ? { kind: write.kind, state: "rejected", stageId: write.stageId, message: status.message }
          : { kind: write.kind, state: "applied", stageId: write.stageId };
    } else if (status.result === "pending") {
      next[key] = { ...write, state: "waiting" };
    }
  }
  return next;
}

/** What the PLC reports about the target of a write: the last id it handled, its result and message. */
function statusOf(
  key: string,
  kind: LiveCommand["kind"],
  parameters: Readonly<Record<string, ParametersMessage>>,
): { handled: number; result: string; message: string } | undefined {
  const at = key.lastIndexOf("#");
  const message = parameters[key.slice(0, at)];
  switch (kind) {
    case "writeParameters":
    case "resetParameters": {
      const status = message?.components.find((c) => c.id === Number(key.slice(at + 1)));
      return status && { handled: status.handledStageId, result: status.result, message: status.message };
    }
    case "writeRecipe":
    case "resetRecipe":
      return message?.recipe && { handled: message.recipe.handledStageId, result: message.recipe.result, message: message.recipe.message };
    case "machineCommand":
      return (
        message?.machineCommand && {
          handled: message.machineCommand.handledCommandId,
          result: message.machineCommand.result,
          message: message.machineCommand.message,
        }
      );
  }
}
