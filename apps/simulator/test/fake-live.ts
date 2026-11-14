import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ComponentConfig,
  type GatewayMessage,
  type Machine,
  type MachineMessage,
  type ParametersMessage,
  type Recipe,
  type RecipeField,
  type WriteResultMessage,
} from "@rpp/protocol";
import { GatewayLive } from "@rpp/machine-view";
import { FakeConnection } from "@rpp/machine-view/testing";
import { Simulator } from "../src/simulator";

export const A = "ads:5.1.2.3.1.1:851";
export const B = "ads:5.1.2.4.1.1:851";

/** The gateway as the Simulator sees it: the real `GatewayLive` over a fake connection. */
export class FakeLive {
  readonly connection = new FakeConnection();
  readonly gateway = new GatewayLive(this.connection);

  /** Every command a Simulator sent. */
  get commands(): readonly ClientMessage[] {
    return this.connection.sent;
  }

  /** How the gateway answers a command; by default it takes it under the next stage id. */
  set answer(answer: (command: ClientMessage) => Omit<WriteResultMessage, "kind" | "requestId">) {
    this.connection.answer = answer;
  }

  /** A message from the gateway. */
  send(message: GatewayMessage | ParametersMessage): void {
    this.connection.deliver(message);
  }

  /** A connected source with these components. */
  plc(sourceId: string, components: ComponentConfig[], name = "Line PLC"): void {
    this.send({ kind: "status", sourceId, sourceName: name, status: { plcConnected: true } });
    this.send({ kind: "config", sourceId, protocolVersion: PROTOCOL_VERSION, configVersion: 1, errors: [], marks: [], components });
  }

  /** The machine as its application reports it. */
  machine(sourceId: string, machine: Partial<Machine> = {}): void {
    this.send({ kind: "machine", sourceId, runState: "stopped", runStateText: "", simulation: true, messages: [], ...machine });
  }

  /** The source's parameters message with this recipe; writable unless said otherwise. */
  recipe(sourceId: string, recipe: Partial<Recipe> = {}, more: Partial<ParametersMessage> = {}): void {
    this.send({
      kind: "parameters",
      sourceId,
      writable: true,
      components: [],
      recipe: { ...RECIPE, ...recipe },
      machineCommand: { handledCommandId: 0, result: "none", message: "" },
      ...more,
    });
  }
}

const field = (f: Partial<RecipeField> & Pick<RecipeField, "name">): RecipeField => ({
  group: 0,
  type: "number",
  unit: "",
  min: 0,
  max: 100,
  programValue: 0,
  choices: [],
  label: "",
  description: "",
  visibleWhen: null,
  ...f,
});

/** A small recipe: Infeed 1 (id 1) and Delta 1 (id 10) fields between machine fields. */
export const FIELDS: RecipeField[] = [
  field({ name: "BeltSpeed", group: 1, unit: "mm/s", min: 10, max: 500, programValue: 150 }),
  field({ name: "RobotSpeed", group: 10, unit: "%", min: 10, max: 100, programValue: 100 }),
  field({ name: "PicksPerCycle", group: 10, type: "integer", min: 1, max: 2, programValue: 2 }),
  field({ name: "Rate", unit: "1/min", min: 1, max: 120, programValue: 60 }),
  field({ name: "TypeMix", type: "choice", min: 0, max: 0, choices: ["Every type", "Boxes", "Round"] }),
  field({ name: "Feed", type: "switch", min: 0, max: 0, programValue: 1 }),
];

export const RECIPE: Recipe = {
  fields: FIELDS,
  activeVersion: 0,
  handledStageId: 0,
  result: "none",
  message: "",
  values: { BeltSpeed: 150, RobotSpeed: 100, PicksPerCycle: 2, Rate: 60, TypeMix: 0, Feed: true },
};

export const infeed = (id = 1): ComponentConfig =>
  ({
    type: "conveyor",
    id,
    name: `Infeed ${id}`,
    pose: { x: 0, y: 0, z: 0, rz: 0 },
    originShift: { x: 0, y: 0, z: 0, rz: 0 },
    length: 2000,
    width: 300,
    body: true,
    productTypes: [],
  }) as unknown as ComponentConfig;

export const message = (m: Partial<MachineMessage> & Pick<MachineMessage, "id" | "text">): MachineMessage => ({
  severity: "warning",
  time: "1000",
  active: true,
  componentId: 0,
  ...m,
});

/** A Simulator following `live`, started, on a machine of source A: Infeed 1, its recipe, stopped in simulation. */
export function simulator(live = new FakeLive(), confirm: () => boolean = () => true): { live: FakeLive; sim: Simulator } {
  live.plc(A, [infeed(1), { ...infeed(10), name: "Delta 1" } as ComponentConfig]);
  live.machine(A);
  live.recipe(A);
  const sim = new Simulator(live.gateway, confirm);
  sim.start();
  return { live, sim };
}
