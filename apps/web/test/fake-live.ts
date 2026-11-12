import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ComponentConfig,
  type ComponentState,
  type GatewayMessage,
  type ParametersMessage,
  type WriteResultMessage,
} from "@rpp/protocol";
import { defaultComponent } from "../src/configurator/component-defaults";
import { Configurator, type ConfiguratorLive } from "../src/configurator/configurator";
import { Sources, type SourceInfo } from "../src/sources";

export const A = "ads:5.1.2.3.1.1:851";

/** The gateway as the configurator sees it: messages sent here reach it like the live ones. */
export class FakeLive implements ConfiguratorLive {
  private readonly sources = new Sources();
  private readonly listeners = new Set<() => void>();
  private snapshot: { sources: readonly SourceInfo[]; parameters: Record<string, ParametersMessage> } = {
    sources: this.sources.all,
    parameters: {},
  };
  now = 0;
  /** Every command a configurator sent. */
  readonly commands: ClientMessage[] = [];
  /** How the gateway answers a command; by default it stages it under the next stage id. */
  answer: (command: ClientMessage) => Omit<WriteResultMessage, "kind" | "requestId"> = () => ({
    ok: true,
    stageId: 100 + this.commands.length,
  });

  send(message: GatewayMessage | ParametersMessage): void {
    if (message.kind === "parameters") {
      this.snapshot = { ...this.snapshot, parameters: { ...this.snapshot.parameters, [message.sourceId]: message } };
    } else {
      this.sources.apply(this.now, message);
      if (this.snapshot.sources === this.sources.all) return;
      this.snapshot = { ...this.snapshot, sources: this.sources.all };
    }
    for (const l of this.listeners) l();
  }

  /** A connected source with these components, and one state of theirs. */
  plc(sourceId: string, components: ComponentConfig[], states: ComponentState[] = []): void {
    this.send({ kind: "status", sourceId, sourceName: "Line PLC", status: { plcConnected: true } });
    this.send({ kind: "config", sourceId, protocolVersion: PROTOCOL_VERSION, configVersion: 1, errors: [], components });
    this.send({ kind: "state", sourceId, configVersion: 1, timestamp: "0", tRel: 100, components: states });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  frame(now = this.now) {
    return this.sources.sceneSources(now);
  }

  async command(command: ClientMessage): Promise<WriteResultMessage> {
    this.commands.push(command);
    return { kind: "writeResult", requestId: command.requestId, ...this.answer(command) };
  }
}

export const conveyor = (id: number, sourceId = A, x = 0) =>
  defaultComponent("conveyor", { id, sourceId, name: `Belt ${id}` }, { x, y: 0 });
export const delta = (id: number, sourceId = A, x = 1000) =>
  defaultComponent("delta", { id, sourceId, name: `Delta ${id}` }, { x, y: 0 });

/** A configurator following `live`, started. */
export function connected(live: FakeLive): Configurator {
  const c = new Configurator(() => true, live);
  c.start();
  return c;
}
