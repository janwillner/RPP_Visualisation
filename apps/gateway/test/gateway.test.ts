import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  GatewayMessageSchema,
  PROTOCOL_VERSION,
  type ConfigMessage,
  type GatewayMessage,
  type StateMessage,
  type StatusMessage,
} from "@rpp/protocol";
import { RECONNECT_MS, combineGateways, createGateway } from "../src/gateway";
import { InMemoryPlc } from "../src/in-memory-plc";
import { startServer } from "../src/server";
import {
  cartesian,
  body,
  conveyor,
  defineMachine,
  delta,
  detector,
  station,
  fingerStates,
  noFault,
  trackModule,
  xtsGantry,
  xtsLoop,
  type MachineComponent,
} from "../src/plc-builders";
import {
  E_VisuBodyRole,
  E_VisuBodyShape,
  E_VisuModuleKind,
  E_VisuProductShape,
  E_VisuProductState,
  MANIFEST_PATH,
  type ST_VisuCartesian,
  type ST_VisuConveyor,
  type ST_VisuDelta,
  type ST_VisuDetector,
  type ST_VisuManifest,
  type ST_VisuXtsGantry,
  type ST_VisuXtsLoop,
} from "../src/plc-contract";

function setup(components: MachineComponent[], options?: Parameters<typeof defineMachine>[2]) {
  const plc = new InMemoryPlc();
  defineMachine(plc, components, options);
  // Gateway clock in ms, advanced explicitly by tests.
  let time = 0;
  const gateway = createGateway({ plc, sourceId: "plc1", sourceName: "Line PLC", now: () => time });
  const messages: GatewayMessage[] = [];
  gateway.subscribe((m) => {
    // Every emitted message must satisfy the browser contract.
    messages.push(GatewayMessageSchema.parse(JSON.parse(JSON.stringify(m))));
  });
  return {
    plc,
    gateway,
    messages,
    advance: (ms: number) => (time += ms),
    configs: () => messages.filter((m): m is ConfigMessage => m.kind === "config"),
    states: () => messages.filter((m): m is StateMessage => m.kind === "state"),
    statuses: () => messages.filter((m): m is StatusMessage => m.kind === "status"),
  };
}

const infeed: MachineComponent = {
  id: 10,
  name: "Infeed",
  path: "MAIN.stInfeed",
  kind: "conveyor",
  value: conveyor({
    pose: { fX: 100, fY: 200, fZ: 800, fRz: 90 },
    length: 3000,
    width: 400,
    productTypes: [
      { nId: 1, fLength: 120, fWidth: 80, fHeight: 40 },
      { nId: 2, fLength: 90, fWidth: 90, fHeight: 60, eShape: E_VisuProductShape.CYLINDER },
      { nId: 3, fLength: 140, fWidth: 90, fHeight: 40, eShape: E_VisuProductShape.ROUNDED_BOX, fCornerRadius: 20 },
    ],
  }),
};

const robot: MachineComponent = {
  id: 20,
  name: "Delta 1",
  path: "MAIN.stDelta1",
  kind: "delta",
  value: delta({
    pose: { fX: 1500, fZ: 1800 },
    baseRadius: 200,
    effectorRadius: 50,
    upperArmLength: 350,
    lowerArmLength: 800,
    zones: [{ nConveyorId: 10, fStart: 1200, fEnd: 1800 }],
  }),
};

const gantry: MachineComponent = {
  id: 30,
  name: "IDH",
  path: "MAIN.fbIdh.stVisu",
  kind: "xtsGantry",
  value: xtsGantry({
    pose: { fX: 3000, fY: -500, fZ: 1500 },
    modules: [trackModule(), trackModule(), trackModule()],
    zones: [{ nConveyorId: 10, fStart: 0, fEnd: 800 }],
  }),
};

const loop: MachineComponent = {
  id: 40,
  name: "Fxx",
  path: "MAIN.fbFxx.stVisu",
  kind: "xtsLoop",
  value: xtsLoop({
    pose: { fX: 5000, fZ: 900 },
    modules: [
      trackModule(),
      trackModule(E_VisuModuleKind.CURVE_LEFT),
      trackModule(E_VisuModuleKind.CURVE_LEFT),
      trackModule(),
      trackModule(E_VisuModuleKind.CURVE_RIGHT, 300),
    ],
    zones: [{ nConveyorId: 10, fStart: 2500, fEnd: 2900 }],
  }),
};

const portal: MachineComponent = {
  id: 50,
  name: "Cartesian",
  path: "MAIN.fbCartesian.stVisu",
  kind: "cartesian",
  value: cartesian({
    pose: { fX: 6000, fY: 100, fZ: 700, fRz: 90 },
    zones: [{ nConveyorId: 10, fStart: 100, fEnd: 900 }],
  }),
};

describe("gateway discovery", () => {
  it("publishes the configured conveyors and deltas as a config message", async () => {
    const t = setup([infeed, robot]);
    await t.gateway.cycle();

    const [config] = t.configs();
    expect(config).toBeDefined();
    expect(config!.errors).toEqual([]);
    expect(config!.configVersion).toBe(1);
    expect(config!.components).toEqual([
      {
        type: "conveyor",
        id: 10,
        sourceId: "plc1",
        name: "Infeed",
        pose: { x: 100, y: 200, z: 800, rx: 0, ry: 0, rz: 90 },
        length: 3000,
        width: 400,
        productTypes: [
          { id: 1, length: 120, width: 80, height: 40, shape: "box", cornerRadius: 0 },
          { id: 2, length: 90, width: 90, height: 60, shape: "cylinder", cornerRadius: 0 },
          { id: 3, length: 140, width: 90, height: 40, shape: "roundedBox", cornerRadius: 20 },
        ],
        originShift: { x: 0, y: 0, z: 0 },
      },
      {
        type: "delta",
        id: 20,
        sourceId: "plc1",
        name: "Delta 1",
        pose: { x: 1500, y: 0, z: 1800, rx: 0, ry: 0, rz: 0 },
        baseRadius: 200,
        effectorRadius: 50,
        upperArmLength: 350,
        lowerArmLength: 800,
        workingArea: { radius: 600, zMin: -1100, zMax: -600, coneHeight: 0, coneBottomRadius: 0 },
        limitArea: null,
        zones: [{ conveyorId: 10, start: 1200, end: 1800, allocationOffset: 0, ccsOffset: 0 }],
        fingers: [],
        originShift: { x: 0, y: 0, z: 0 },
      },
    ]);
  });

  it("publishes a Delta's limit area and the zones' allocation offsets", async () => {
    const limited: MachineComponent = {
      ...robot,
      value: delta({
        limitArea: { fXMin: -500, fXMax: 500, fYMin: -700, fYMax: 700, fZMin: -1400, fZMax: -600 },
        zones: [
          { nConveyorId: 10, fStart: 1200, fEnd: 1800, fAllocationOffset: 250 },
          { nConveyorId: 10, fStart: 2000, fEnd: 2400 },
        ],
      }),
    };
    const t = setup([infeed, limited]);
    await t.gateway.cycle();

    const config = t.configs()[0]!.components.find((c) => c.type === "delta");
    expect(config).toMatchObject({
      limitArea: { xMin: -500, xMax: 500, yMin: -700, yMax: 700, zMin: -1400, zMax: -600 },
      zones: [
        { conveyorId: 10, start: 1200, end: 1800, allocationOffset: 250 },
        { conveyorId: 10, start: 2000, end: 2400, allocationOffset: 0 },
      ],
    });
  });

  it("publishes each zone's CCS offset and every component's origin shift, zero when not set", async () => {
    const shiftedBelt: MachineComponent = { ...infeed, value: conveyor({ originShift: { fX: 500, fY: -20 } }) };
    const robotWithCcs: MachineComponent = {
      ...robot,
      value: delta({
        originShift: { fZ: -700 },
        zones: [
          { nConveyorId: 10, fStart: 1200, fEnd: 1800, fCcsOffset: 1350 },
          { nConveyorId: 10, fStart: 2000, fEnd: 2400 },
        ],
      }),
    };
    const gantry: MachineComponent = { id: 30, name: "IDH", path: "MAIN.stIdh", kind: "xtsGantry", value: xtsGantry() };
    const t = setup([shiftedBelt, robotWithCcs, gantry]);
    await t.gateway.cycle();

    const [belt, d, g] = t.configs()[0]!.components;
    expect(belt!.originShift).toEqual({ x: 500, y: -20, z: 0 });
    expect(d!.originShift).toEqual({ x: 0, y: 0, z: -700 });
    expect(g!.originShift).toEqual({ x: 0, y: 0, z: 0 });
    expect(d!.type === "delta" && d!.zones.map((z) => z.ccsOffset)).toEqual([1350, 0]);
  });

  it("publishes XTS gantries and loops with their geometry and zones", async () => {
    const t = setup([infeed, gantry, loop]);
    await t.gateway.cycle();

    const [config] = t.configs();
    expect(config!.errors).toEqual([]);
    expect(config!.components.slice(1)).toEqual([
      {
        type: "xtsGantry",
        id: 30,
        sourceId: "plc1",
        name: "IDH",
        pose: { x: 3000, y: -500, z: 1500, rx: 0, ry: 0, rz: 0 },
        modules: [
          { kind: "straight", length: 250 },
          { kind: "straight", length: 250 },
          { kind: "straight", length: 250 },
        ],
        xMin: -50,
        xMax: 300,
        zMin: -200,
        zMax: 0,
        toolOffsetX: 150,
        toolOffsetZ: -400,
        moverLength: 155,
        moverWidth: 80,
        zones: [{ conveyorId: 10, start: 0, end: 800, allocationOffset: 0, ccsOffset: 0 }],
        fingers: [],
        originShift: { x: 0, y: 0, z: 0 },
      },
      {
        type: "xtsLoop",
        id: 40,
        sourceId: "plc1",
        name: "Fxx",
        pose: { x: 5000, y: 0, z: 900, rx: 0, ry: 0, rz: 0 },
        modules: [
          { kind: "straight", length: 250 },
          { kind: "curveLeft", length: 250 },
          { kind: "curveLeft", length: 250 },
          { kind: "straight", length: 250 },
          { kind: "curveRight", length: 300 },
        ],
        toolOffset: 120,
        moverLength: 100,
        moverWidth: 60,
        zones: [{ conveyorId: 10, start: 2500, end: 2900, allocationOffset: 0, ccsOffset: 0 }],
        fingers: [],
        originShift: { x: 0, y: 0, z: 0 },
      },
    ]);
  });

  it("publishes a Cartesian robot with its strokes, rail height and zones", async () => {
    const t = setup([infeed, portal]);
    await t.gateway.cycle();

    const [config] = t.configs();
    expect(config!.errors).toEqual([]);
    expect(config!.components[1]).toEqual({
      type: "cartesian",
      id: 50,
      sourceId: "plc1",
      name: "Cartesian",
      pose: { x: 6000, y: 100, z: 700, rx: 0, ry: 0, rz: 90 },
      xMin: 0,
      xMax: 1200,
      yMin: 0,
      yMax: 1000,
      zMin: -600,
      zMax: 0,
      railHeight: 1200,
      zones: [{ conveyorId: 10, start: 100, end: 900, allocationOffset: 0, ccsOffset: 0 }],
      fingers: [],
      originShift: { x: 0, y: 0, z: 0 },
    });
  });

  it("publishes a vision system and a product sensor with their zones and the bodies they are drawn from", async () => {
    const vision: MachineComponent = {
      id: 60,
      name: "Vision 1",
      path: "MAIN.fbVision.vo_Visu",
      kind: "vision",
      value: detector({
        pose: { fX: 500, fY: 200, fZ: 1600 },
        zones: [{ nConveyorId: 10, fStart: 300, fEnd: 700, fCcsOffset: 500 }],
        bodies: [
          body({ fLength: 120, fWidth: 80, fHeight: 150 }),
          body({
            eShape: E_VisuBodyShape.FRUSTUM,
            eRole: E_VisuBodyRole.FIELD_OF_VIEW,
            stPose: { fX: 0, fY: 0, fZ: -800, fRx: 0, fRy: 0, fRz: 0 },
            fLength: 400,
            fWidth: 300,
            fHeight: 800,
            fTopLength: 20,
            fTopWidth: 15,
          }),
        ],
      }),
    };
    const barrier: MachineComponent = {
      id: 61,
      name: "Sensor 1",
      path: "MAIN.fbSensor.vo_Visu",
      kind: "sensor",
      value: detector({
        zones: [{ nConveyorId: 10, fStart: 200, fEnd: 200 }],
        bodies: [body({ eShape: E_VisuBodyShape.CYLINDER, eRole: E_VisuBodyRole.BEAM, fLength: 6, fWidth: 6, fHeight: 500 })],
      }),
    };
    const t = setup([infeed, vision, barrier]);
    await t.gateway.cycle();

    const [config] = t.configs();
    expect(config!.errors).toEqual([]);
    const zero = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
    expect(config!.components[1]).toEqual({
      type: "vision",
      id: 60,
      sourceId: "plc1",
      name: "Vision 1",
      pose: { ...zero, x: 500, y: 200, z: 1600 },
      zones: [{ conveyorId: 10, start: 300, end: 700, allocationOffset: 0, ccsOffset: 500 }],
      bodies: [
        { shape: "box", role: "structure", pose: zero, length: 120, width: 80, height: 150, topLength: 0, topWidth: 0 },
        {
          shape: "frustum",
          role: "fieldOfView",
          pose: { ...zero, z: -800 },
          length: 400,
          width: 300,
          height: 800,
          topLength: 20,
          topWidth: 15,
        },
      ],
      originShift: { x: 0, y: 0, z: 0 },
    });
    expect(config!.components[2]).toMatchObject({
      type: "sensor",
      zones: [{ conveyorId: 10, start: 200, end: 200 }],
      bodies: [{ shape: "cylinder", role: "beam", length: 6, width: 6, height: 500 }],
    });
  });

  it("refuses a PLC with a different protocol version and publishes no component data", async () => {
    const t = setup([infeed, robot], { protocolVersion: 99 });
    await t.gateway.cycle();
    await t.gateway.cycle();

    const [config] = t.configs();
    expect(config!.components).toEqual([]);
    expect(config!.errors).toHaveLength(1);
    expect(config!.errors[0]!.message).toMatch(new RegExp(`protocol version 99.*expects ${PROTOCOL_VERSION}`, "i"));
    expect(t.states()).toEqual([]);
  });

  it("names the Syn_Visu version the PLC runs, also when the protocol versions differ", async () => {
    const t = setup([infeed, robot], { libraryVersion: "5.1.0" });
    await t.gateway.cycle();
    expect(t.configs()[0]!.libraryVersion).toBe("5.1.0");

    const old = setup([infeed, robot], { protocolVersion: 99, libraryVersion: "4.0.0" });
    await old.gateway.cycle();
    expect(old.configs()[0]!.libraryVersion).toBe("4.0.0");
    expect(old.configs()[0]!.errors[0]!.message).toMatch(/protocol version 99 \(Syn_Visu 4\.0\.0\)/);
  });

  it("leaves the Syn_Visu version out for a library older than 5.1, whose manifest does not report it", async () => {
    const t = setup([infeed, robot]);
    await t.gateway.cycle();
    expect(t.configs()[0]!.libraryVersion).toBeUndefined();
    expect(t.configs()[0]!.components).toHaveLength(2);
  });

  it("recovers once the PLC reports the expected protocol version, without a config version change", async () => {
    const t = setup([infeed, robot], { protocolVersion: 99 });
    await t.gateway.cycle();
    expect(t.configs()[0]!.components).toEqual([]);

    // E.g. an online change of the library: same config version, new protocol version.
    t.plc.get<ST_VisuManifest>(MANIFEST_PATH).nProtocolVersion = PROTOCOL_VERSION;
    await t.gateway.cycle();

    const latest = t.configs().at(-1)!;
    expect(latest.errors).toEqual([]);
    expect(latest.components.map((c) => c.id)).toEqual([10, 20]);
    expect(t.states()).toHaveLength(1);
  });

  it("skips and reports a manifest entry whose symbol has the wrong data type, keeping the rest", async () => {
    const t = setup([infeed, robot]);
    t.plc.define(robot.path, "ST_SomethingElse", robot.value);
    await t.gateway.cycle();

    const [config] = t.configs();
    expect(config!.components.map((c) => c.id)).toEqual([10]);
    expect(config!.errors).toEqual([
      {
        componentId: 20,
        path: "MAIN.stDelta1",
        message: expect.stringMatching(/expected type ST_VisuDelta.*ST_SomethingElse/),
      },
    ]);
  });

  it("accepts interface types reported with the library namespace", async () => {
    const t = setup([infeed, robot]);
    t.plc.define(robot.path, "Syn_Visu.ST_VisuDelta", robot.value);
    await t.gateway.cycle();

    const [config] = t.configs();
    expect(config!.errors).toEqual([]);
    expect(config!.components.map((c) => c.id)).toEqual([10, 20]);
  });

  it("discovers through a manifest at a configured symbol path", async () => {
    const plc = new InMemoryPlc();
    defineMachine(plc, [infeed], { manifestPath: "GVL_RppVisu.stManifest" });
    const gateway = createGateway({ plc, sourceId: "plc1", manifestPath: "GVL_RppVisu.stManifest" });
    const messages: GatewayMessage[] = [];
    gateway.subscribe((m) => messages.push(m));

    await gateway.cycle();

    const config = messages.find((m): m is ConfigMessage => m.kind === "config");
    expect(config?.components.map((c) => c.name)).toEqual(["Infeed"]);
    expect(messages.some((m) => m.kind === "state")).toBe(true);
  });

  it("reports a manifest entry whose symbol path does not exist", async () => {
    const t = setup([infeed, robot]);
    t.plc.remove(infeed.path);
    await t.gateway.cycle();

    const [config] = t.configs();
    expect(config!.components.map((c) => c.id)).toEqual([20]);
    expect(config!.errors).toEqual([
      { componentId: 10, path: "MAIN.stInfeed", message: expect.stringMatching(/missing/i) },
    ]);
  });

  it("reports a component whose config cannot be read and still publishes the others", async () => {
    const t = setup([infeed, robot]);
    t.plc.define(robot.path, "ST_VisuDelta", { stState: (robot.value as ST_VisuDelta).stState });
    await t.gateway.cycle();

    const [config] = t.configs();
    expect(t.statuses().at(-1)!.status.plcConnected).toBe(true);
    expect(config!.components.map((c) => c.id)).toEqual([10]);
    expect(config!.errors).toEqual([
      { componentId: 20, path: "MAIN.stDelta1", message: expect.stringMatching(/stConfig/) },
    ]);
    expect(t.states()).toHaveLength(1);
  });
});

describe("gateway config changes", () => {
  it("publishes a config changed live in the PLC without a version bump on the next recheck (1 s)", async () => {
    const t = setup([infeed, robot]);
    await t.gateway.cycle();

    t.plc.get<ST_VisuDelta>(robot.path).stConfig.stWorkingArea.fRadius = 800;
    t.advance(500);
    await t.gateway.cycle();
    expect(t.configs()).toHaveLength(1);

    t.advance(500);
    await t.gateway.cycle();
    const configs = t.configs();
    expect(configs).toHaveLength(2);
    expect(configs[1]!.configVersion).toBe(1);
    expect(configs[1]!.components.find((c) => c.id === 20)).toMatchObject({ workingArea: { radius: 800 } });
  });

  it("does not republish an unchanged config on recheck and keeps the snapshot timeline", async () => {
    const t = setup([infeed, robot]);
    await t.gateway.cycle();
    t.advance(1000);
    t.plc.get<ST_VisuConveyor>(infeed.path).stState.nTimestamp = 50_000_000n;
    await t.gateway.cycle();

    expect(t.configs()).toHaveLength(1);
    expect(t.states().map((s) => s.tRel)).toEqual([0, 50]);
  });


  it("rediscovers and publishes a new config when the PLC increments the config version", async () => {
    const t = setup([infeed, robot]);
    await t.gateway.cycle();

    t.plc.get<ST_VisuConveyor>(infeed.path).stConfig.fLength = 4500;
    await t.gateway.cycle();
    expect(t.configs()).toHaveLength(1);

    t.plc.get<ST_VisuManifest>(MANIFEST_PATH).nConfigVersion = 2;
    await t.gateway.cycle();

    const configs = t.configs();
    expect(configs).toHaveLength(2);
    expect(configs[1]!.configVersion).toBe(2);
    expect(configs[1]!.components.find((c) => c.id === 10)).toMatchObject({ length: 4500 });
    expect(t.states().at(-1)!.configVersion).toBe(2);
  });
});

describe("gateway subscribers", () => {
  it("sends a late-joining subscriber the current status and config before any state", async () => {
    const t = setup([infeed, robot]);
    await t.gateway.cycle();
    await t.gateway.cycle();

    const late: GatewayMessage[] = [];
    t.gateway.subscribe((m) => late.push(m));
    await t.gateway.cycle();

    expect(late.map((m) => m.kind)).toEqual(["status", "config", "state"]);
    expect(late[0]).toEqual({ kind: "status", sourceId: "plc1", sourceName: "Line PLC", status: { plcConnected: true } });
  });

  it("marks every message with the source it comes from", async () => {
    const t = setup([infeed, robot]);
    await t.gateway.cycle();

    expect(t.messages.map((m) => m.sourceId)).toEqual(["plc1", "plc1", "plc1", "plc1"]);
  });
});

describe("gateway connection", () => {
  it("reports a lost PLC connection without throwing and rediscovers after reconnect", async () => {
    const t = setup([infeed, robot]);
    await t.gateway.cycle();

    t.plc.setOnline(false);
    await t.gateway.cycle();
    await t.gateway.cycle();
    expect(t.statuses().at(-1)!.status).toEqual({ plcConnected: false, lastError: "PLC not reachable" });
    const statesWhileOffline = t.states().length;

    t.plc.setOnline(true);
    t.advance(RECONNECT_MS);
    await t.gateway.cycle();

    // Initial status on subscribe, connected, lost, connected again.
    expect(t.statuses().map((s) => s.status.plcConnected)).toEqual([false, true, false, true]);
    expect(t.configs()).toHaveLength(2);
    expect(t.states().length).toBe(statesWhileOffline + 1);
  });

  it("waits 5 s after a failed attempt before trying the PLC again", async () => {
    const t = setup([infeed, robot]);
    await t.gateway.cycle();
    t.plc.setOnline(false);
    await t.gateway.cycle();
    t.plc.setOnline(true);

    t.advance(RECONNECT_MS - 1);
    await t.gateway.cycle();
    expect(t.statuses().at(-1)!.status.plcConnected).toBe(false);

    t.advance(1);
    await t.gateway.cycle();
    expect(t.statuses().at(-1)!.status.plcConnected).toBe(true);
  });
});

describe("gateway with several PLC sources", () => {
  function twoSources() {
    const a = new InMemoryPlc();
    const b = new InMemoryPlc();
    // Both PLCs use the same manifest ids: ids are unique per source only.
    defineMachine(a, [infeed, robot], { libraryVersion: "5.1.0" });
    defineMachine(b, [{ ...infeed, name: "Outfeed" }]);
    let time = 0;
    const gateways = [
      createGateway({ plc: a, sourceId: "ads:5.1.2.3.1.1:851", sourceName: "Infeed PLC", now: () => time }),
      createGateway({ plc: b, sourceId: "ads:5.1.2.4.1.1:851", sourceName: "Outfeed PLC", now: () => time }),
    ];
    const hub = combineGateways(gateways);
    const messages: GatewayMessage[] = [];
    hub.subscribe((m) => messages.push(GatewayMessageSchema.parse(JSON.parse(JSON.stringify(m)))));
    const cycleAll = () => Promise.all(gateways.map((g) => g.cycle()));
    return { a, b, gateways, messages, cycleAll, advance: (ms: number) => (time += ms) };
  }
  const configsOf = (messages: GatewayMessage[], sourceId: string) =>
    messages.filter((m): m is ConfigMessage => m.kind === "config" && m.sourceId === sourceId);
  const statesOf = (messages: GatewayMessage[], sourceId: string) =>
    messages.filter((m): m is StateMessage => m.kind === "state" && m.sourceId === sourceId);

  it("publishes the components of every source, each under its own source id, even with the same manifest ids", async () => {
    const t = twoSources();
    await t.cycleAll();

    const a = configsOf(t.messages, "ads:5.1.2.3.1.1:851")[0]!;
    const b = configsOf(t.messages, "ads:5.1.2.4.1.1:851")[0]!;
    expect(a.components.map((c) => [c.sourceId, c.id, c.name])).toEqual([
      ["ads:5.1.2.3.1.1:851", 10, "Infeed"],
      ["ads:5.1.2.3.1.1:851", 20, "Delta 1"],
    ]);
    expect(b.components.map((c) => [c.sourceId, c.id, c.name])).toEqual([["ads:5.1.2.4.1.1:851", 10, "Outfeed"]]);
    expect(statesOf(t.messages, "ads:5.1.2.4.1.1:851")[0]!.components.map((c) => c.id)).toEqual([10]);
  });

  it("sends a late-joining subscriber the status and config of every source", async () => {
    const t = twoSources();
    await t.cycleAll();

    const late: GatewayMessage[] = [];
    combineGateways(t.gateways).subscribe((m) => late.push(m));

    expect(late.map((m) => [m.kind, m.sourceId])).toEqual([
      ["status", "ads:5.1.2.3.1.1:851"],
      ["config", "ads:5.1.2.3.1.1:851"],
      ["status", "ads:5.1.2.4.1.1:851"],
      ["config", "ads:5.1.2.4.1.1:851"],
    ]);
  });

  it("keeps publishing the other sources while one is unreachable, and picks the lost one up again", async () => {
    const t = twoSources();
    await t.cycleAll();
    t.b.setOnline(false);
    await t.cycleAll();
    const before = statesOf(t.messages, "ads:5.1.2.3.1.1:851").length;

    await t.cycleAll();
    await t.cycleAll();
    expect(statesOf(t.messages, "ads:5.1.2.3.1.1:851").length).toBe(before + 2);
    const lost = t.messages.filter((m): m is StatusMessage => m.kind === "status" && m.sourceId === "ads:5.1.2.4.1.1:851");
    expect(lost.at(-1)!).toMatchObject({ sourceName: "Outfeed PLC", status: { plcConnected: false } });

    t.b.setOnline(true);
    t.advance(RECONNECT_MS);
    await t.cycleAll();
    expect(configsOf(t.messages, "ads:5.1.2.4.1.1:851")).toHaveLength(2);
    expect(statesOf(t.messages, "ads:5.1.2.4.1.1:851").length).toBe(2);
  });

  it("reports the versions and every source's health at /health: 200 while all are connected, 503 once one is not", async () => {
    const ISO_TIME = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const t = twoSources();
    const server = await startServer({ gateway: combineGateways(t.gateways), port: 0, host: "127.0.0.1", version: "1.2.3" });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
    try {
      await t.cycleAll();
      const healthy = await fetch(url);
      expect(healthy.status).toBe(200);
      expect(await healthy.json()).toMatchObject({
        ok: true,
        version: "1.2.3",
        protocolVersion: PROTOCOL_VERSION,
        sources: [
          {
            sourceId: "ads:5.1.2.3.1.1:851",
            name: "Infeed PLC",
            plcConnected: true,
            lastStateAt: ISO_TIME,
            libraryVersion: "5.1.0",
          },
          { sourceId: "ads:5.1.2.4.1.1:851", name: "Outfeed PLC", plcConnected: true, lastStateAt: ISO_TIME },
        ],
      });

      t.b.setOnline(false);
      await t.cycleAll();
      const degraded = await fetch(url);
      expect(degraded.status).toBe(503);
      const body = (await degraded.json()) as {
        ok: boolean;
        sources: { plcConnected: boolean; lastError?: string; lastStateAt?: string }[];
      };
      expect(body.ok).toBe(false);
      expect(body.sources.map((s) => s.plcConnected)).toEqual([true, false]);
      expect(body.sources[1]!.lastError).toBeTruthy();
      // The source that dropped out still tells when its last state came.
      expect(body.sources[1]!.lastStateAt).toEqual(ISO_TIME);
    } finally {
      server.close();
    }
  });
});

describe("gateway state snapshots", () => {
  // DC time values beyond 2^53 to prove no precision is lost.
  const T0 = 820_000_000_123_456_789n;

  function advance(plc: InMemoryPlc, timestamp: bigint, beltPosition: number) {
    plc.get<ST_VisuConveyor>(infeed.path).stState.nTimestamp = timestamp;
    plc.get<ST_VisuConveyor>(infeed.path).stState.fBeltPosition = beltPosition;
    plc.get<ST_VisuDelta>(robot.path).stState.nTimestamp = timestamp;
  }

  it("publishes one snapshot per cycle with the PLC timestamp as string and tRel in ms", async () => {
    const t = setup([infeed, robot]);
    advance(t.plc, T0, 100);
    await t.gateway.cycle();
    advance(t.plc, T0 + 20_000_000n, 110);
    await t.gateway.cycle();

    const states = t.states();
    expect(states).toHaveLength(2);
    expect(states.map((s) => s.timestamp)).toEqual([T0.toString(), (T0 + 20_000_000n).toString()]);
    expect(states.map((s) => s.tRel)).toEqual([0, 20]);
    expect(states[1]!.components).toContainEqual({
      type: "conveyor",
      id: 10,
      timestamp: (T0 + 20_000_000n).toString(),
      beltPosition: 110,
      products: [],
      fault: null,
    });
  });

  it("publishes valid register entries only, mapped to the neutral product model", async () => {
    const t = setup([infeed, robot]);
    const state = t.plc.get<ST_VisuConveyor>(infeed.path).stState;
    state.nProductCount = 3;
    state.aProducts[0] = {
      nId: 7,
      bValid: true,
      stLatchPose: { fX: 150, fY: 210, fZ: 800, fRz: 15 },
      fLatchBeltPosition: 40,
      eState: E_VisuProductState.PICKED,
      ePreviousState: E_VisuProductState.ASSIGNED,
      nLastClientId: 20,
      nMoverId: 3,
      nFingerId: 2,
      nProductType: 1,
    };
    state.aProducts[1] = { ...state.aProducts[0], nId: 8, bValid: false };
    // Enumerations objectified by the ADS client.
    state.aProducts[2] = { ...state.aProducts[0], nId: 9, eState: { name: "PLACED", value: E_VisuProductState.PLACED } };
    await t.gateway.cycle();

    const conveyorState = t.states()[0]!.components.find((c) => c.id === 10);
    expect(conveyorState).toMatchObject({
      products: [
        {
          id: 7,
          latchPose: { x: 150, y: 210, z: 800, rz: 15 },
          latchBeltPosition: 40,
          state: "picked",
          previousState: "assigned",
          lastClientId: 20,
          moverId: 3,
          fingerId: 2,
          productType: 1,
        },
        { id: 9, state: "placed" },
      ],
    });
  });

  it("publishes an XTS gantry's Z position and its valid movers", async () => {
    const t = setup([infeed, gantry]);
    const s = t.plc.get<ST_VisuXtsGantry>(gantry.path).stState;
    s.fZ = -120;
    s.nMoverCount = 3;
    const mover = (nId: number, bValid: boolean, fPosition: number, fX: number, bGripperActive: boolean) => ({
      nId,
      bValid,
      fPosition,
      fX,
      bGripperActive,
      aFingerStates: fingerStates(),
      stFault: noFault(),
    });
    s.aMovers[0] = mover(1, true, 250, 80, true);
    s.aMovers[1] = mover(2, false, 500, 0, false);
    s.aMovers[2] = mover(3, true, 900, -20, false);
    // Beyond nMoverCount: ignored even if marked valid.
    s.aMovers[3] = mover(4, true, 1200, 0, false);
    await t.gateway.cycle();

    expect(t.states()[0]!.components).toContainEqual({
      type: "xtsGantry",
      id: 30,
      timestamp: "0",
      z: -120,
      movers: [
        { id: 1, position: 250, x: 80, gripperActive: true, fingers: [], fault: null },
        { id: 3, position: 900, x: -20, gripperActive: false, fingers: [], fault: null },
      ],
      modules: [{ fault: null }, { fault: null }, { fault: null }],
      fault: null,
    });
  });

  it("publishes an XTS loop's valid movers", async () => {
    const t = setup([infeed, loop]);
    const s = t.plc.get<ST_VisuXtsLoop>(loop.path).stState;
    s.nMoverCount = 2;
    s.aMovers[0] = { nId: 11, bValid: true, fPosition: 120, aFingerStates: fingerStates(), stFault: noFault() };
    s.aMovers[1] = { nId: 12, bValid: true, fPosition: 2600, aFingerStates: fingerStates(), stFault: noFault() };
    await t.gateway.cycle();

    expect(t.states()[0]!.components).toContainEqual({
      type: "xtsLoop",
      id: 40,
      timestamp: "0",
      movers: [
        { id: 11, position: 120, fingers: [], fault: null },
        { id: 12, position: 2600, fingers: [], fault: null },
      ],
      modules: [{ fault: null }, { fault: null }, { fault: null }, { fault: null }, { fault: null }],
      fault: null,
    });
  });

  it("publishes a Cartesian robot's axis values and gripper", async () => {
    const t = setup([infeed, portal]);
    const s = t.plc.get<ST_VisuCartesian>(portal.path).stState;
    Object.assign(s, { fX: 600, fY: 250, fZ: -400, bGripperActive: true });
    await t.gateway.cycle();

    expect(t.states()[0]!.components).toContainEqual({
      type: "cartesian",
      id: 50,
      timestamp: "0",
      x: 600,
      y: 250,
      z: -400,
      gripperActive: true,
      fingers: [],
      fault: null,
    });
  });

  it("publishes a station from its own structure: zones, bodies and a lit body while it works", async () => {
    const rejectUnit: MachineComponent = {
      id: 70,
      name: "Reject unit",
      path: "MAIN.fbReject.vo_Visu",
      kind: "station",
      value: station({
        pose: { fX: 900, fY: -300, fZ: 800 },
        zones: [{ nConveyorId: 10, fStart: 900, fEnd: 900 }],
        bodies: [body({ fLength: 200, fWidth: 150, fHeight: 300 }), body({ fLength: 60, fWidth: 100, fHeight: 40 })],
        active: [false, true],
      }),
    };
    const t = setup([infeed, rejectUnit]);
    await t.gateway.cycle();

    const [config] = t.configs();
    expect(config!.errors).toEqual([]);
    expect(config!.components[1]).toMatchObject({
      type: "station",
      id: 70,
      name: "Reject unit",
      pose: { x: 900, y: -300, z: 800 },
      zones: [{ conveyorId: 10, start: 900, end: 900 }],
      bodies: [
        { shape: "box", role: "structure", length: 200, width: 150, height: 300 },
        { shape: "box", role: "structure", length: 60, width: 100, height: 40 },
      ],
    });
    expect(t.states()[0]!.components).toContainEqual({
      type: "station",
      id: 70,
      timestamp: "0",
      bodies: [{ active: false }, { active: true }],
      fault: null,
    });
  });

  it("refuses a station symbol of another data type", async () => {
    const wrong: MachineComponent = { id: 70, name: "Reject unit", path: "MAIN.fbReject.vo_Visu", kind: "station", value: station() };
    const plc = new InMemoryPlc();
    defineMachine(plc, [infeed, wrong]);
    // E.g. an application that put a detector where its manifest names a station.
    plc.define(wrong.path, "ST_VisuDetector", station());
    const gateway = createGateway({ plc, sourceId: "plc1" });
    const configs: ConfigMessage[] = [];
    gateway.subscribe((m) => m.kind === "config" && configs.push(m));
    await gateway.cycle();
    expect(configs[0]!.components.map((c) => c.id)).toEqual([10]);
    expect(configs[0]!.errors[0]).toMatchObject({ componentId: 70, message: expect.stringMatching(/ST_VisuStation/) });
  });

  it("publishes one state per configured body of a detector, with its fault", async () => {
    const barrier: MachineComponent = {
      id: 61,
      name: "Sensor 1",
      path: "MAIN.fbSensor.vo_Visu",
      kind: "sensor",
      value: detector({ bodies: [body(), body({ eRole: E_VisuBodyRole.BEAM })], active: [false, true] }),
    };
    const t = setup([infeed, barrier]);
    t.plc.get<ST_VisuDetector>(barrier.path).stState.stFault = { bActive: true, sMessage: "Dirty lens" };
    await t.gateway.cycle();

    expect(t.states()[0]!.components).toContainEqual({
      type: "sensor",
      id: 61,
      timestamp: "0",
      bodies: [{ active: false }, { active: true }],
      fault: { message: "Dirty lens" },
    });
  });

  it("publishes the configured fingers and one live state per configured finger, per mover", async () => {
    const withFingers: MachineComponent = {
      ...gantry,
      value: xtsGantry({
        fingers: [
          { fDiameter: 40, fHeight: 50 },
          { fDiameter: 20, fHeight: 120 },
        ],
        movers: [
          {
            nId: 1,
            fPosition: 250,
            aFingerStates: fingerStates([
              { stPose: { fX: 1, fY: 2, fZ: 3, fRx: 10, fRy: 0, fRz: 90 }, bActive: true },
              { stPose: { fX: 4, fY: 5, fZ: 6, fRx: 0, fRy: 0, fRz: 0 }, bActive: false },
              // Beyond nFingerCount: ignored.
              { stPose: { fX: 7, fY: 8, fZ: 9, fRx: 0, fRy: 0, fRz: 0 }, bActive: true },
            ]),
          },
        ],
      }),
    };
    const t = setup([infeed, withFingers]);
    await t.gateway.cycle();

    const config = t.configs()[0]!.components.find((c) => c.type === "xtsGantry");
    expect(config?.fingers).toEqual([
      { diameter: 40, height: 50 },
      { diameter: 20, height: 120 },
    ]);
    const state = t.states()[0]!.components.find((c) => c.type === "xtsGantry");
    expect(state?.type === "xtsGantry" && state.movers[0]!.fingers).toEqual([
      { pose: { x: 1, y: 2, z: 3, rx: 10, ry: 0, rz: 90 }, active: true },
      { pose: { x: 4, y: 5, z: 6, rx: 0, ry: 0, rz: 0 }, active: false },
    ]);
  });

  it("publishes a component's fault and the fault of each valid mover, null when there is none", async () => {
    const faulted: MachineComponent = {
      ...gantry,
      value: xtsGantry({
        fault: { bActive: true, sMessage: "Z axis error" },
        movers: [
          { nId: 1, fPosition: 250, stFault: { bActive: true, sMessage: "following error" } },
          { nId: 2, fPosition: 500 },
          // An inactive fault is no fault, whatever message is left in it.
          { nId: 3, fPosition: 900, stFault: { bActive: false, sMessage: "old" } },
        ],
      }),
    };
    const t = setup([infeed, faulted]);
    await t.gateway.cycle();

    const components = t.states()[0]!.components;
    const state = components.find((c) => c.type === "xtsGantry");
    expect(state?.fault).toEqual({ message: "Z axis error" });
    expect(state?.type === "xtsGantry" && state.movers.map((m) => m.fault)).toEqual([
      { message: "following error" },
      null,
      null,
    ]);
    expect(components.find((c) => c.type === "conveyor")?.fault).toBeNull();
  });

  it("publishes one state per configured track module, with its fault", async () => {
    const faulted: MachineComponent = {
      ...loop,
      value: xtsLoop({
        modules: [trackModule(), trackModule(), trackModule(E_VisuModuleKind.CURVE_LEFT)],
        moduleFaults: [undefined, { bActive: true, sMessage: "Overtemperature" }, { bActive: false, sMessage: "old" }],
      }),
    };
    const t = setup([infeed, faulted]);
    await t.gateway.cycle();

    const state = t.states()[0]!.components.find((c) => c.type === "xtsLoop");
    // The PLC reports a state for every possible module; only the three configured ones are kept.
    expect(state?.type === "xtsLoop" && state.modules).toEqual([
      { fault: null },
      { fault: { message: "Overtemperature" } },
      { fault: null },
    ]);
  });

  it("publishes the fault of an XTS loop's mover", async () => {
    const faulted: MachineComponent = {
      ...loop,
      value: xtsLoop({ movers: [{ nId: 11, fPosition: 120, stFault: { bActive: true, sMessage: "" } }] }),
    };
    const t = setup([infeed, faulted]);
    await t.gateway.cycle();

    const state = t.states()[0]!.components.find((c) => c.type === "xtsLoop");
    // An empty message is passed on as is; the visualisation decides what to show.
    expect(state?.type === "xtsLoop" && state.movers[0]!.fault).toEqual({ message: "" });
  });

  it("publishes the delta's actual and setpoint TCP", async () => {
    const t = setup([infeed, robot]);
    const s = t.plc.get<ST_VisuDelta>(robot.path).stState;
    s.stActualTcp = { fX: 1, fY: 2, fZ: -900 };
    s.stSetpointTcp = { fX: 3, fY: 4, fZ: -905 };
    await t.gateway.cycle();

    expect(t.states()[0]!.components).toContainEqual({
      type: "delta",
      id: 20,
      timestamp: "0",
      actualTcp: { x: 1, y: 2, z: -900 },
      setpointTcp: { x: 3, y: 4, z: -905 },
      fingers: [],
      fault: null,
    });
  });
});
