import { PROTOCOL_VERSION, type ComponentConfig, type ComponentState } from "@rpp/protocol";
import { FakeGateway } from "@rpp/machine-view/testing";
import { defaultComponent } from "../src/component-defaults";
import { Configurator } from "../src/configurator";

export const A = "ads:5.1.2.3.1.1:851";

/** The gateway as the configurator sees it: the real `GatewayLive` over a fake connection. */
export class FakeLive extends FakeGateway {
  /** A connected source with these components, and one state of theirs. */
  plc(sourceId: string, components: ComponentConfig[], states: ComponentState[] = []): void {
    this.send({ kind: "status", sourceId, sourceName: "Line PLC", status: { plcConnected: true } });
    this.send({ kind: "config", sourceId, protocolVersion: PROTOCOL_VERSION, configVersion: 1, errors: [], marks: [], components });
    this.send({ kind: "state", sourceId, configVersion: 1, timestamp: "0", tRel: 100, components: states });
  }
}

export const conveyor = (id: number, sourceId = A, x = 0) =>
  defaultComponent("conveyor", { id, sourceId, name: `Belt ${id}` }, { x, y: 0 });
export const delta = (id: number, sourceId = A, x = 1000) =>
  defaultComponent("delta", { id, sourceId, name: `Delta ${id}` }, { x, y: 0 });

/** A configurator following `live`, started. */
export function connected(live: FakeLive): Configurator {
  const c = new Configurator(() => true, live.gateway);
  c.start();
  return c;
}
