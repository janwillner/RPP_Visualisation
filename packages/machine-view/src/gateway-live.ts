import type { ClientMessage, ParametersMessage, WriteResultMessage } from "@rpp/protocol";
import type { GatewayConnection } from "./gateway-connection";
import type { SceneSource } from "./scene/scene-model";
import type { SourceInfo } from "./sources";

/** The sources and, per source whose PLC has Syn_Config, its parameter sets and recipe. */
export type LiveSnapshot = { sources: readonly SourceInfo[]; parameters: Readonly<Record<string, ParametersMessage>> };

/** A command not answered within this time counts as failed. */
const COMMAND_TIMEOUT_MS = 10_000;

/**
 * The gateway as the configurator and the Simulator read it (ADR 0016, 0017, 0022): the connection's sources plus, per
 * source, its PLC's parameter sets and recipe, and the commands on them with their answers.
 */
export class GatewayLive {
  private snapshot: LiveSnapshot;
  private readonly listeners = new Set<() => void>();
  /**
   * Commands sent and waiting for their `writeResult`, by the request id given here (unique on this connection), with
   * the caller's own id to answer with.
   */
  private readonly commands = new Map<number, { requestId: number; answer: (answer: WriteResultMessage) => void }>();
  private nextRequest = 1;

  constructor(private readonly connection: GatewayConnection) {
    this.snapshot = { sources: connection.getSnapshot().sources, parameters: {} };
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
        this.update({ parameters: { ...this.snapshot.parameters, [message.sourceId]: message } });
      } else {
        this.commands.get(message.requestId)?.answer(message);
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
   * Sends a command on parameter sets and gives the gateway's answer; a lost connection answers that the command may
   * not have arrived.
   */
  command(command: ClientMessage): Promise<WriteResultMessage> {
    const id = this.nextRequest++;
    return new Promise((resolve) => {
      const finish = (answer: WriteResultMessage) => {
        clearTimeout(timer);
        this.commands.delete(id);
        resolve({ ...answer, requestId: command.requestId });
      };
      // A gateway that ignores the command (too old, or it found the command invalid) never answers.
      const timer = setTimeout(
        () => finish({ kind: "writeResult", requestId: id, ok: false, error: "The gateway did not answer the command." }),
        COMMAND_TIMEOUT_MS,
      );
      this.commands.set(id, { requestId: command.requestId, answer: finish });
      if (!this.connection.send({ ...command, requestId: id })) {
        finish({ kind: "writeResult", requestId: id, ok: false, error: "Not connected to the gateway." });
      }
    });
  }

  /** Commands still waiting are not answered on a lost connection; the parameter sets come again with the next. */
  private lost(): void {
    for (const [requestId, { answer }] of [...this.commands]) {
      answer({ kind: "writeResult", requestId, ok: false, error: "The connection to the gateway was lost; the command may not have arrived." });
    }
    this.update({ parameters: {} });
  }

  private update(patch: Partial<LiveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }
}
