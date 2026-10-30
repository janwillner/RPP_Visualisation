import { describe, expect, it } from "vitest";
import {
  GatewayMessageSchema,
  PROTOCOL_VERSION,
  type ConfigMessage,
  type GatewayMessage,
  type StateMessage,
  type StatusMessage,
} from "@rpp/protocol";
import { createGateway } from "../src/gateway";
import { InMemoryPlc } from "../src/in-memory-plc";
import { conveyor, defineMachine, delta, xtsGantry, xtsLoop, type MachineComponent } from "../src/plc-builders";
import {
  E_VisuProductState,
  E_VisuZoneKind,
  MANIFEST_PATH,
  type ST_VisuConveyor,
  type ST_VisuDelta,
  type ST_VisuManifest,
  type ST_VisuXtsGantry,
  type ST_VisuXtsLoop,
} from "../src/plc-contract";

function setup(components: MachineComponent[], options?: Parameters<typeof defineMachine>[2]) {
  const plc = new InMemoryPlc();
  defineMachine(plc, components, options);
  // Gateway clock in ms, advanced explicitly by tests.
  let time = 0;
  const gateway = createGateway({ plc, sourceId: "plc1", now: () => time });
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
    productTypes: [{ nId: 1, fLength: 120, fWidth: 80, fHeight: 40 }],
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
    zones: [{ nConveyorId: 10, fStart: 1200, fEnd: 1800, eKind: E_VisuZoneKind.PICK }],
  }),
};

const gantry: MachineComponent = {
  id: 30,
  name: "IDH",
  path: "MAIN.fbIdh.stVisu",
  kind: "xtsGantry",
  value: xtsGantry({
    pose: { fX: 3000, fY: -500, fZ: 1500 },
    moduleCount: 3,
    moduleLength: 1000,
    zones: [{ nConveyorId: 10, fStart: 0, fEnd: 800, eKind: E_VisuZoneKind.PICK }],
  }),
};

const loop: MachineComponent = {
  id: 40,
  name: "Fxx",
  path: "MAIN.fbFxx.stVisu",
  kind: "xtsLoop",
  value: xtsLoop({
    pose: { fX: 5000, fZ: 900 },
    straightLength: 2000,
    curveRadius: 250,
    zones: [{ nConveyorId: 10, fStart: 2500, fEnd: 2900, eKind: E_VisuZoneKind.PLACE }],
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
        productTypes: [{ id: 1, length: 120, width: 80, height: 40 }],
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
        hasRotationAxis: false,
        workingArea: { radius: 600, zMin: -1100, zMax: -600, coneHeight: 0, coneBottomRadius: 0 },
        zones: [{ conveyorId: 10, start: 1200, end: 1800, kind: "pick" }],
      },
    ]);
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
        moduleCount: 3,
        moduleLength: 1000,
        xMin: -50,
        xMax: 300,
        zMin: -200,
        zMax: 0,
        cMin: -180,
        cMax: 180,
        toolOffsetX: 150,
        toolOffsetZ: -400,
        moverLength: 155,
        moverWidth: 80,
        zones: [{ conveyorId: 10, start: 0, end: 800, kind: "pick" }],
      },
      {
        type: "xtsLoop",
        id: 40,
        sourceId: "plc1",
        name: "Fxx",
        pose: { x: 5000, y: 0, z: 900, rx: 0, ry: 0, rz: 0 },
        straightLength: 2000,
        curveRadius: 250,
        toolOffset: 120,
        moverLength: 100,
        moverWidth: 60,
        zones: [{ conveyorId: 10, start: 2500, end: 2900, kind: "place" }],
      },
    ]);
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
    expect(late[0]).toEqual({ kind: "status", status: { plcConnected: true } });
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
    await t.gateway.cycle();

    // Initial status on subscribe, connected, lost, connected again.
    expect(t.statuses().map((s) => s.status.plcConnected)).toEqual([false, true, false, true]);
    expect(t.configs()).toHaveLength(2);
    expect(t.states().length).toBe(statesWhileOffline + 1);
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
      nRobotId: 20,
      nMoverId: 3,
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
          robotId: 20,
          moverId: 3,
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
    s.aMovers[0] = { nId: 1, bValid: true, fPosition: 250, fX: 80, fC: 45, bGripperActive: true };
    s.aMovers[1] = { nId: 2, bValid: false, fPosition: 500, fX: 0, fC: 0, bGripperActive: false };
    s.aMovers[2] = { nId: 3, bValid: true, fPosition: 900, fX: -20, fC: -90, bGripperActive: false };
    // Beyond nMoverCount: ignored even if marked valid.
    s.aMovers[3] = { nId: 4, bValid: true, fPosition: 1200, fX: 0, fC: 0, bGripperActive: false };
    await t.gateway.cycle();

    expect(t.states()[0]!.components).toContainEqual({
      type: "xtsGantry",
      id: 30,
      timestamp: "0",
      z: -120,
      movers: [
        { id: 1, position: 250, x: 80, c: 45, gripperActive: true },
        { id: 3, position: 900, x: -20, c: -90, gripperActive: false },
      ],
    });
  });

  it("publishes an XTS loop's valid movers", async () => {
    const t = setup([infeed, loop]);
    const s = t.plc.get<ST_VisuXtsLoop>(loop.path).stState;
    s.nMoverCount = 2;
    s.aMovers[0] = { nId: 11, bValid: true, fPosition: 120 };
    s.aMovers[1] = { nId: 12, bValid: true, fPosition: 2600 };
    await t.gateway.cycle();

    expect(t.states()[0]!.components).toContainEqual({
      type: "xtsLoop",
      id: 40,
      timestamp: "0",
      movers: [
        { id: 11, position: 120 },
        { id: 12, position: 2600 },
      ],
    });
  });

  it("publishes the delta's actual and setpoint TCP", async () => {
    const t = setup([infeed, robot]);
    const s = t.plc.get<ST_VisuDelta>(robot.path).stState;
    s.stActualTcp = { fX: 1, fY: 2, fZ: -900, fRz: 45 };
    s.stSetpointTcp = { fX: 3, fY: 4, fZ: -905, fRz: 46 };
    await t.gateway.cycle();

    expect(t.states()[0]!.components).toContainEqual({
      type: "delta",
      id: 20,
      timestamp: "0",
      actualTcp: { x: 1, y: 2, z: -900, rz: 45 },
      setpointTcp: { x: 3, y: 4, z: -905, rz: 46 },
    });
  });
});
