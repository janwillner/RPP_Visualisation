import { describe, expect, it } from "vitest";
import type {
  CartesianConfig,
  CartesianState,
  ConfigMessage,
  ConveyorConfig,
  DeltaConfig,
  GantryMover,
  FingerState,
  Position,
  Product,
  ProductType,
  SensorConfig,
  StationConfig,
  StateMessage,
  VisionConfig,
  XtsGantryConfig,
  TrackModule,
  XtsLoopConfig,
  Zone,
} from "@rpp/protocol";
import {
  availableSnapPoints,
  buildMachineScene,
  buildScene,
  componentKey,
  formatPointCopy,
  measureChain,
  pointsCsv,
  rendererToMcs,
  type Vec3,
} from "../src/scene/scene-model";

const S45 = Math.SQRT1_2;

function closeTo(actual: readonly number[], expected: readonly number[], digits = 6) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, digits));
}

function conveyorConfig(overrides: Partial<ConveyorConfig> = {}): ConveyorConfig {
  return {
    type: "conveyor",
    id: 1,
    sourceId: "plc1",
    name: "Infeed",
    pose: { x: 0, y: 0, z: 800, rx: 0, ry: 0, rz: 0 },
    length: 3000,
    width: 400,
    productTypes: [{ id: 1, length: 100, width: 80, height: 40, shape: "box", cornerRadius: 0 }],
    body: true,
    originShift: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

function config(...components: ConfigMessage["components"]): ConfigMessage {
  return { kind: "config", sourceId: "plc1", protocolVersion: 1, configVersion: 1, components, errors: [], marks: [] };
}

describe("scene model: MCS to renderer frame", () => {
  it("places a conveyor at its MCS pose converted to metres with Y up", () => {
    const scene = buildScene(
      config(conveyorConfig({ pose: { x: 1000, y: 2000, z: 800, rx: 0, ry: 0, rz: 90 }, length: 3000, width: 400 })),
      [],
      0,
    );

    const [conveyor] = scene.conveyors;
    // MCS (x, y, z) -> renderer (x, z, -y); rotation about MCS Z is rotation about renderer Y.
    closeTo(conveyor!.transform.position, [1, 0.8, -2]);
    closeTo(conveyor!.transform.quaternion, [0, S45, 0, S45]);
    expect(conveyor!.length).toBeCloseTo(3);
    expect(conveyor!.width).toBeCloseTo(0.4);
  });

  it("converts a point picked in the renderer back to MCS millimetres", () => {
    // Renderer (x, y, z) m with Y up -> MCS (x, -z, y) mm with Z up.
    closeTo(rendererToMcs([1, 0.8, -2]), [1000, 2000, 800]);
    closeTo(rendererToMcs([-0.25, 0, 0.5]), [-250, -500, 0]);
  });

  it("applies pose rotations in the order Rz · Ry · Rx", () => {
    // Rx(90) tilts the belt's local Y up to Z, then Rz(90) turns the conveying direction from MCS +X to +Y.
    const scene = buildScene(
      config(conveyorConfig({ pose: { x: 0, y: 0, z: 0, rx: 90, ry: 0, rz: 90 } })),
      [],
      0,
    );
    const q = scene.conveyors[0]!.transform.quaternion;

    // Conveying direction (local +X) -> MCS +Y -> renderer -Z.
    closeTo(rotate(q, [1, 0, 0]), [0, 0, -1]);
    // Renderer local +Z is MCS local -Y, which Rx(90) turns into MCS -Z -> renderer -Y.
    closeTo(rotate(q, [0, 0, 1]), [0, -1, 0]);
  });
});

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 7,
    latchPose: { x: 0, y: 0, z: 0, rz: 0 },
    latchBeltPosition: 0,
    mark: 0,
    state: "detected",
    previousState: "detected",
    lastClientId: 0,
    moverId: 0,
    fingerId: 0,
    productType: 1,
    ...overrides,
  };
}

function snapshot(tRel: number, components: StateMessage["components"]): StateMessage {
  return { kind: "state", sourceId: "plc1", configVersion: 1, timestamp: String(tRel * 1e6), tRel, components };
}

function conveyorState(beltPosition: number, products: Product[], id = 1): StateMessage["components"][number] {
  return { type: "conveyor", id, timestamp: "0", beltPosition, products, fault: null };
}

describe("scene model: product tracking", () => {
  it("moves a product from its latch pose in the conveyor's coordinate system along the belt by the belt travel", () => {
    // Turned by 90°: the belt runs along MCS +Y, its coordinate system starts 100 mm along it at MCS (1000, 100).
    const belt = conveyorConfig({ pose: { x: 1000, y: 0, z: 800, rx: 0, ry: 0, rz: 90 }, originShift: { x: 100, y: 0, z: 0 } });
    const p = product({ latchPose: { x: 0, y: -50, z: 0, rz: 15 }, latchBeltPosition: 40 });

    const scene = buildScene(config(belt), [snapshot(0, [conveyorState(540, [p])])], 0);

    const [shown] = scene.products;
    expect(shown).toMatchObject({ productId: 7, conveyorId: 1, display: "normal", state: "detected" });
    // Bottom centre 500 mm further at belt (500, -50), i.e. MCS (1050, 600, 800); the box centre sits 20 mm above.
    closeTo(shown!.transform.position, [1.05, 0.82, -0.6]);
    // Turned with the belt (90°) plus its own 15°.
    const a = (105 * Math.PI) / 180;
    closeTo(rotate(shown!.transform.quaternion, [1, 0, 0]), [Math.cos(a), 0, -Math.sin(a)]);
    expect(shown!.size).toEqual({ length: 0.1, width: 0.08, height: 0.04 });
  });

  it("gives products snap points only when asked, as the 3D view does while measuring", () => {
    const belt = conveyorConfig();
    const snapshots = [snapshot(0, [conveyorState(540, [product()])])];
    const productPoints = (scene: ReturnType<typeof buildScene>) => scene.snapPoints.filter((s) => s.label.startsWith("Product #"));

    expect(productPoints(buildScene(config(belt), snapshots, 0)).length).toBeGreaterThan(0);
    const without = buildScene(config(belt), snapshots, 0, new Set(), { measureSnapPoints: false });
    expect(productPoints(without)).toEqual([]);
    expect(without.products).toHaveLength(1);
    // The conveyor's own points stay.
    expect(without.snapPoints.length).toBeGreaterThan(0);
  });
});

describe("scene model: interpolation", () => {
  const belt = conveyorConfig();
  const p = product({ latchPose: { x: 100, y: 0, z: 0, rz: 0 } });
  const xAt = (snapshots: StateMessage[], t: number) => buildScene(config(belt), snapshots, t).products[0]!.transform.position[0];

  it("interpolates the belt position linearly between the surrounding snapshots by tRel", () => {
    const snapshots = [snapshot(0, [conveyorState(0, [p])]), snapshot(20, [conveyorState(100, [p])])];
    expect(xAt(snapshots, 5)).toBeCloseTo(0.125);
    expect(xAt(snapshots, 20)).toBeCloseTo(0.2);
  });

  it("holds the oldest or newest snapshot outside the buffered range instead of extrapolating", () => {
    const snapshots = [snapshot(10, [conveyorState(0, [p])]), snapshot(30, [conveyorState(100, [p])])];
    expect(xAt(snapshots, 0)).toBeCloseTo(0.1);
    expect(xAt(snapshots, 50)).toBeCloseTo(0.2);
  });

  it("tolerates out-of-order and duplicate snapshots", () => {
    const snapshots = [
      snapshot(40, [conveyorState(200, [p])]),
      snapshot(20, [conveyorState(100, [p])]),
      snapshot(20, [conveyorState(100, [p])]),
    ];
    expect(xAt(snapshots, 30)).toBeCloseTo(0.25);
  });
});

function deltaConfig(overrides: Partial<DeltaConfig> = {}): DeltaConfig {
  return {
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
    tcpLimitArea: null,
    zones: [],
    fingers: [],
    originShift: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

/** sqrt(800² − (200 + 350 − 50)²): TCP depth below the base at which all upper arms are horizontal. */
const HORIZONTAL_DEPTH = 624.4997998398398;

function deltaState(
  tcp: Position,
  setpoint = tcp,
  id = 20,
  fingers: FingerState[] = [],
): StateMessage["components"][number] {
  return { type: "delta", id, timestamp: "0", actualTcp: tcp, setpointTcp: setpoint, fingers, fault: null };
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(...a.map((v, i) => v - b[i]!));

describe("scene model: delta follows the TCP", () => {
  it("draws all upper arms horizontal when the TCP is straight below the base at the closing depth", () => {
    const tcp = { x: 1500, y: 0, z: 1800 - HORIZONTAL_DEPTH };
    const [d] = buildScene(config(deltaConfig()), [snapshot(0, [deltaState(tcp)])], 0).deltas;

    expect(d!.reachable).toBe(true);
    closeTo(d!.base.position, [1.5, 1.8, 0]);
    // Arm 1 along +X, arm 2 at 120° counter-clockwise seen from above (MCS +Y is renderer -Z).
    closeTo(d!.shoulders[0]!, [1.7, 1.8, 0]);
    closeTo(d!.elbows[0]!, [2.05, 1.8, 0]);
    closeTo(d!.elbows[1]!, [1.5 - 0.275, 1.8, -0.4763139720814413]);
    closeTo(d!.effector!.position, [1.5, 1.8 - HORIZONTAL_DEPTH / 1000, 0]);
    closeTo(d!.angles, [0, 0, 0], 4);
    // Plate sizes for drawing, in metres.
    expect(d!.baseRadius).toBeCloseTo(0.2);
    expect(d!.effectorRadius).toBeCloseTo(0.05);
  });

  it("keeps every arm at its configured length for an off-centre TCP on a rotated base", () => {
    const cfg = deltaConfig({ pose: { x: 1500, y: 200, z: 1800, rx: 0, ry: 0, rz: 30 } });
    const tcp = { x: 1650, y: 80, z: 1050 };
    const [d] = buildScene(config(cfg), [snapshot(0, [deltaState(tcp)])], 0).deltas;

    expect(d!.reachable).toBe(true);
    closeTo(d!.effector!.position, [1.65, 1.05, -0.08]);
    for (let i = 0; i < 3; i++) {
      expect(dist(d!.shoulders[i]!, d!.elbows[i]!)).toBeCloseTo(0.35, 6);
      expect(dist(d!.elbows[i]!, d!.effectorJoints[i]!)).toBeCloseTo(0.8, 6);
      expect(dist(d!.effectorJoints[i]!, d!.effector!.position)).toBeCloseTo(0.05, 6);
    }
  });

  it("turns upper arm 1 with the base: Rz 90° points it along MCS +Y, Rz -90° along -Y", () => {
    for (const [rz, y] of [
      [90, 0.2],
      [-90, -0.2],
    ] as const) {
      const cfg = deltaConfig({ pose: { x: 1500, y: 0, z: 1800, rx: 0, ry: 0, rz } });
      const tcp = { x: 1500, y: 0, z: 1800 - HORIZONTAL_DEPTH };
      const [d] = buildScene(config(cfg), [snapshot(0, [deltaState(tcp)])], 0).deltas;

      // Shoulder 1 at base + 200 mm along MCS ±Y; MCS +Y is renderer -Z.
      closeTo(d!.shoulders[0]!, [1.5, 1.8, -y]);
    }
  });

  it("marks a TCP the arms cannot reach as unreachable but still shows the effector at the TCP", () => {
    const [d] = buildScene(config(deltaConfig()), [snapshot(0, [deltaState({ x: 1500, y: 0, z: 0 })])], 0).deltas;
    expect(d!.reachable).toBe(false);
    expect(d!.elbows).toEqual([]);
    closeTo(d!.effector!.position, [1.5, 0, 0]);
  });

  it("shows the setpoint TCP reported by the PLC as a separate marker", () => {
    const scene = buildScene(
      config(deltaConfig()),
      [snapshot(0, [deltaState({ x: 1500, y: 100, z: 1000 }, { x: 1510, y: 100, z: 1000 })])],
      0,
    );
    closeTo(scene.deltas[0]!.actualTcp!, [1.5, 1, -0.1]);
    closeTo(scene.deltas[0]!.setpointTcp!, [1.51, 1, -0.1]);
  });

  it("interpolates the TCP between snapshots and the arms follow", () => {
    const snapshots = [
      snapshot(0, [deltaState({ x: 1500, y: 0, z: 1000 })]),
      snapshot(20, [deltaState({ x: 1600, y: 0, z: 1000 })]),
    ];
    const d = buildScene(config(deltaConfig()), snapshots, 10).deltas[0]!;
    closeTo(d.effector!.position, [1.55, 1, 0]);
    closeTo(d.actualTcp!, [1.55, 1, 0]);
  });

  it("keeps the effector turned with the base: tool rotations belong to the gripper", () => {
    const cfg = deltaConfig({ pose: { x: 1500, y: 0, z: 1800, rx: 0, ry: 0, rz: 30 } });
    const d = buildScene(config(cfg), [snapshot(0, [deltaState({ x: 1500, y: 0, z: 1000 })])], 0).deltas[0]!;
    closeTo(rotate(d.effector!.quaternion, [1, 0, 0]), [Math.cos(Math.PI / 6), 0, -Math.sin(Math.PI / 6)]);
  });
});

/** A finger state at an MCS position, turned about Z by rz. */
function fingerAt(x: number, y: number, z: number, rz = 0, active = true): FingerState {
  return { pose: { x, y, z, rx: 0, ry: 0, rz }, poseReported: true, active };
}

/** A finger state whose pose the application did not report: the finger is placed by its offset. */
const unreported = (active = false): FingerState => ({ pose: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }, poseReported: false, active });

const onFlange = { x: 0, y: 0, z: 0, rz: 0 };

describe("scene model: gripper fingers", () => {
  const cup = { diameter: 40, height: 50, offset: onFlange };
  const robot = deltaConfig({ fingers: [cup] });
  const flange = { x: 1500, y: 0, z: 1000 };
  const at = (fingers: FingerState[], products: Product[] = [], hidden?: ReadonlySet<number>) =>
    buildScene(
      config(conveyorConfig(), robot),
      [snapshot(0, [conveyorState(0, products), deltaState(flange, flange, 20, fingers)])],
      0,
      hidden,
    );

  it("draws each configured finger as a cylinder at its MCS pose, connected to the flange", () => {
    const [finger] = at([fingerAt(1500, 0, 1000, 90)]).fingers;

    expect(finger).toMatchObject({ key: "20:0:1", robotId: 20, moverId: 0, index: 1, active: true });
    closeTo(finger!.transform.position, [1.5, 1, 0]);
    // Turned by 90° about Z: its local +X points along MCS +Y (renderer −Z).
    closeTo(rotate(finger!.transform.quaternion, [1, 0, 0]), [0, 0, -1]);
    closeTo([finger!.diameter, finger!.height], [0.04, 0.05]);
    closeTo(finger!.flange, [1.5, 1, 0]);
  });

  it("hangs a product picked with a finger id below that finger's grip point, turned with the finger", () => {
    const picked = product({ state: "picked", lastClientId: 20, fingerId: 1, latchPose: { x: 1000, y: 0, z: 0, rz: 0 } });
    const carried = at([fingerAt(1500, 0, 1000, 90)], [picked]).products.find((p) => p.display === "atTcp")!;

    // Grip point 50 mm below the finger top, the 40 mm product's centre 20 mm below that.
    closeTo(carried.transform.position, [1.5, 0.93, 0]);
    closeTo(rotate(carried.transform.quaternion, [1, 0, 0]), [0, 0, -1]);
  });

  it("hangs a product with finger id 0 at the flange", () => {
    const picked = product({ state: "picked", lastClientId: 20, fingerId: 0 });
    const carried = at([fingerAt(1500, 0, 1000)], [picked]).products.find((p) => p.display === "atTcp")!;
    closeTo(carried.transform.position, [1.5, 0.98, 0]);
  });

  it("keeps the flange frame of a turned Delta along the MCS axes", () => {
    const turned = deltaConfig({ fingers: [cup], pose: { x: 1500, y: 0, z: 1800, rx: 0, ry: 0, rz: 30 } });
    const picked = product({ state: "picked", lastClientId: 20, fingerId: 0 });
    const scene = buildScene(
      config(conveyorConfig(), turned),
      [snapshot(0, [conveyorState(0, [picked]), deltaState(flange, flange, 20, [fingerAt(1500, 0, 1000)])])],
      0,
    );
    const carried = scene.products.find((p) => p.display === "atTcp")!;
    closeTo(rotate(carried.transform.quaternion, [1, 0, 0]), [1, 0, 0]);
  });

  it("hangs a product from an unknown finger at the flange and warns", () => {
    const picked = product({ state: "picked", lastClientId: 20, fingerId: 3 });
    const scene = at([fingerAt(1500, 0, 1000)], [picked]);
    closeTo(scene.products.find((p) => p.display === "atTcp")!.transform.position, [1.5, 0.98, 0]);
    expect(scene.warnings).toEqual([expect.stringMatching(/finger 3/)]);
  });

  it("interpolates finger poses, angles across the ±180° wrap the short way", () => {
    const state = (rz: number, x: number) => deltaState(flange, flange, 20, [fingerAt(x, 0, 1000, rz)]);
    const [finger] = buildScene(config(robot), [snapshot(0, [state(179, 1500)]), snapshot(20, [state(-179, 1600)])], 10).fingers;
    closeTo(finger!.transform.position, [1.55, 1, 0]);
    // Halfway between 179° and −179° is 180°: local +X along MCS −X.
    closeTo(rotate(finger!.transform.quaternion, [1, 0, 0]), [-1, 0, 0]);
  });

  it("offers each finger's grip point as a moving snap point in the robot's frame", () => {
    const point = at([fingerAt(1500, 0, 1000)]).snapPoints.find((p) => p.label === "Delta 1 · finger 1 grip point")!;
    closeTo(point.mcs, [1500, 0, 950]);
    closeTo(point.local.point, [0, 0, -850]);
    expect(point.moving).toBe(true);
  });

  it("ignores finger states beyond the configured fingers and drops the fingers of a hidden robot", () => {
    expect(at([fingerAt(1500, 0, 1000), fingerAt(1600, 0, 1000)]).fingers).toHaveLength(1);
    expect(at([fingerAt(1500, 0, 1000)], [], new Set([20])).fingers).toEqual([]);
  });

  it("gives every mover of an XTS gantry its own fingers", () => {
    const gantry = gantryConfig({ fingers: [cup] });
    const movers = [
      { ...mover1, id: 1, fingers: [fingerAt(2750, -270, 1050)] },
      { ...mover1, id: 2, position: 600, fingers: [fingerAt(2400, -270, 1050, 0, false)] },
    ];
    const scene = buildScene(config(gantry), [snapshot(0, [gantryState(-100, movers)])], 0);
    expect(scene.fingers.map((f) => [f.key, f.active])).toEqual([
      ["30:1:1", true],
      ["30:2:1", false],
    ]);
    // A mover's flag no longer colours the flange once fingers are configured.
    expect(scene.gantries[0]!.movers[0]!.gripperActive).toBe(false);
  });

  // ADR 0018: a finger whose pose the application does not report hangs at its offset on the flange.
  const offsetCup = { ...cup, offset: { x: 70, y: 0, z: -10, rz: 90 } };
  const robotWith = (rz: number) => deltaConfig({ fingers: [offsetCup], pose: { x: 1500, y: 0, z: 1800, rx: 0, ry: 0, rz } });

  it("places a finger whose pose is not reported by its offset on a Delta's flange: at the TCP, along the robot's axes", () => {
    const [finger] = buildScene(config(robotWith(0)), [snapshot(0, [deltaState(flange, flange, 20, [unreported(true)])])], 0).fingers;
    // TCP (1500, 0, 1000) + (70, 0, −10).
    closeTo(finger!.transform.position, [1.57, 0.99, 0]);
    // Turned by 90° about the flange's Z: its local +X along MCS +Y (renderer −Z).
    closeTo(rotate(finger!.transform.quaternion, [1, 0, 0]), [0, 0, -1]);
    expect(finger!.active).toBe(true);
  });

  it("turns a Delta's finger layout with the robot: the gripper is bolted to its effector", () => {
    const [finger] = buildScene(config(robotWith(90)), [snapshot(0, [deltaState(flange, flange, 20, [unreported()])])], 0).fingers;
    // Turned by 90°: the offset (70, 0) along the robot's X points along MCS +Y, renderer −Z.
    closeTo(finger!.transform.position, [1.5, 0.99, -0.07]);
    // The finger's rz of 90° adds to the robot's: its local +X along MCS −X.
    closeTo(rotate(finger!.transform.quaternion, [1, 0, 0]), [-1, 0, 0]);
  });

  it("places every finger by its offset when the state has no finger states at all, e.g. a draft's rest state", () => {
    const two = deltaConfig({ fingers: [offsetCup, { ...cup, offset: { x: -70, y: 0, z: 0, rz: 0 } }] });
    const fingers = buildScene(config(two), [snapshot(0, [deltaState(flange, flange, 20, [])])], 0).fingers;
    expect(fingers.map((f) => f.active)).toEqual([false, false]);
    closeTo(fingers[1]!.transform.position, [1.43, 1, 0]);
  });

  it("hangs a product below a finger placed by its offset", () => {
    const picked = product({ state: "picked", lastClientId: 20, fingerId: 1 });
    const scene = buildScene(
      config(conveyorConfig(), deltaConfig({ fingers: [offsetCup] })),
      [snapshot(0, [conveyorState(0, [picked]), deltaState(flange, flange, 20, [unreported(true)])])],
      0,
    );
    // Grip point 50 mm below the finger top at (1570, 0, 990); the 40 mm product's centre 20 mm below that.
    closeTo(scene.products.find((p) => p.display === "atTcp")!.transform.position, [1.57, 0.92, 0]);
  });

  it("places an XTS mover's fingers by their offset in the mover's frame, turned with the mover", () => {
    const gantry = gantryConfig({ fingers: [{ ...cup, offset: { x: 20, y: 0, z: 0, rz: 0 } }] });
    const scene = buildScene(config(gantry), [snapshot(0, [gantryState(-100, [{ ...mover1, fingers: [unreported()] }])])], 0);
    const [finger] = scene.fingers;
    // The gantry is turned by 90°: the mover's +X (its X axis) points along MCS +Y, renderer −Z.
    closeTo(finger!.transform.position, [finger!.flange[0], finger!.flange[1], finger!.flange[2] - 0.02]);
  });
});

describe("scene model: product lifecycle", () => {
  const belt = conveyorConfig({ length: 3000 });
  const robot = deltaConfig();
  const tcp = { x: 1500, y: 0, z: 1000 };
  const show = (p: Product, beltPosition = 0) =>
    buildScene(config(belt, robot), [snapshot(0, [conveyorState(beltPosition, [p]), deltaState(tcp)])], 0).products;

  it("hangs a picked product below its robot's TCP and leaves a placeholder travelling on the belt", () => {
    const shown = show(product({ state: "picked", lastClientId: 20, latchPose: { x: 1000, y: 0, z: 0, rz: 0 } }), 200);

    expect(shown.map((p) => p.display).sort()).toEqual(["atTcp", "placeholder"]);
    // The product's top touches the TCP: centre 20 mm (half of 40 mm) below.
    closeTo(shown.find((p) => p.display === "atTcp")!.transform.position, [1.5, 0.98, 0]);
    closeTo(shown.find((p) => p.display === "placeholder")!.transform.position, [1.2, 0.82, 0]);
    expect(new Set(shown.map((p) => p.key)).size).toBe(2);
  });

  it("removes the placeholder once it passes the belt end, without flagging it as missed", () => {
    // Latched at belt x = 1000, travelled 2100 mm -> belt x = 3100 beyond the 3000 mm belt.
    const shown = show(product({ state: "picked", lastClientId: 20, latchPose: { x: 1000, y: 0, z: 0, rz: 0 } }), 2100);
    expect(shown.map((p) => p.display)).toEqual(["atTcp"]);
  });

  it("shows a placed product lying on the belt it was put down on, and hides it past the belt end", () => {
    const placed = product({ state: "placed", lastClientId: 20, latchPose: { x: 1000, y: 0, z: 0, rz: 0 } });
    const shown = show(placed, 200);
    expect(shown.map((p) => p.display)).toEqual(["normal"]);
    closeTo(shown[0]!.transform.position, [1.2, 0.82, 0]);
    expect(show(placed, 2100)).toEqual([]);
  });

  it("flags an unpicked product that ran past the belt end as missed and holds it at the belt end", () => {
    for (const state of ["detected", "assigned"] as const) {
      const shown = show(product({ state, latchPose: { x: 2900, y: 0, z: 0, rz: 0 } }), 500);
      expect(shown).toHaveLength(1);
      expect(shown[0]!.display).toBe("missed");
      // Held with its front edge at the belt end: centre half a length (50 mm) before 3000 mm.
      closeTo(shown[0]!.transform.position, [2.95, 0.82, 0]);
    }
  });

  it("shows a product stacked on another at its height above the belt, travelling with it", () => {
    const below = product({ id: 7, state: "placed", latchPose: { x: 1000, y: 0, z: 0, rz: 0 } });
    const above = product({ id: 8, state: "placed", latchPose: { x: 1000, y: 0, z: 40, rz: 0 } });
    const shown = buildScene(config(belt), [snapshot(0, [conveyorState(200, [below, above])])], 0).products;

    // Both 200 mm further; the 40 mm product below ends at 840 mm, the one above is centred 20 mm higher.
    closeTo(shown.find((p) => p.productId === 7)!.transform.position, [1.2, 0.82, 0]);
    closeTo(shown.find((p) => p.productId === 8)!.transform.position, [1.2, 0.86, 0]);
  });

  it("hides a rejected product beyond the belt end instead of flagging it as missed", () => {
    const shown = show(product({ state: "rejected", latchPose: { x: 2900, y: 0, z: 0, rz: 0 } }), 500);
    expect(shown).toEqual([]);
  });

  it("shows only the register entries present in the snapshot", () => {
    expect(show(product(), 0)).toHaveLength(1);
    const scene = buildScene(config(belt, robot), [snapshot(0, [conveyorState(0, [])])], 0);
    expect(scene.products).toEqual([]);
  });
});

describe("scene model: hidden components", () => {
  it("drops a hidden robot's geometry, areas, zones, snap points and origin", () => {
    const belt = conveyorConfig();
    const robot = deltaConfig({
      zones: [{ conveyorId: 1, start: 1200, end: 1800, allocationOffset: 0, ccsOffset: 0, startY: 0, endY: 0 }],
      limitArea: { xMin: -500, xMax: 500, yMin: -700, yMax: 700, zMin: -1400, zMax: -600 },
    });
    const scene = buildScene(config(belt, robot), [], 0, new Set([20]));

    expect(scene.deltas).toEqual([]);
    expect(scene.workingAreas).toEqual([]);
    expect(scene.limitAreas).toEqual([]);
    expect(scene.zones).toEqual([]);
    expect(scene.snapPoints.filter((p) => p.label.startsWith("Delta 1"))).toEqual([]);
    expect(scene.origins.map((o) => o.componentId)).toEqual([1]);
    expect(scene.conveyors).toHaveLength(1);
  });

  it("drops a hidden conveyor with its products and the zones on it, keeping the robot", () => {
    const belt = conveyorConfig();
    const robot = deltaConfig({ zones: [{ conveyorId: 1, start: 1200, end: 1800, allocationOffset: 0, ccsOffset: 0, startY: 0, endY: 0 }] });
    const scene = buildScene(config(belt, robot), [snapshot(0, [conveyorState(0, [product()])])], 0, new Set([1]));

    expect(scene.conveyors).toEqual([]);
    expect(scene.products).toEqual([]);
    expect(scene.zones).toEqual([]);
    expect(scene.warnings).toEqual([]);
    expect(scene.deltas).toHaveLength(1);
  });
});

describe("scene model: working areas and zones", () => {
  it("resolves a robot's zones onto the referenced conveyor in belt coordinates", () => {
    const belt = conveyorConfig({ pose: { x: 1000, y: 0, z: 800, rx: 0, ry: 0, rz: 90 }, width: 400 });
    const robot = deltaConfig({
      zones: [
        { conveyorId: 1, start: 1200, end: 1800, allocationOffset: 0, ccsOffset: 1500, startY: 0, endY: 0 },
        { conveyorId: 99, start: 0, end: 100, allocationOffset: 0, ccsOffset: 0, startY: 0, endY: 0 },
      ],
    });
    const scene = buildScene(config(belt, robot), [], 0);

    expect(scene.zones).toHaveLength(1);
    const [w] = scene.zones;
    expect(w).toMatchObject({ componentId: 20, conveyorId: 1 });
    // Centre at belt x = 1500 along the belt's +X, which points along MCS +Y.
    closeTo(w!.transform.position, [1, 0.8, -1.5]);
    closeTo(rotate(w!.transform.quaternion, [1, 0, 0]), [0, 0, -1]);
    expect(w!.length).toBeCloseTo(0.6);
    expect(w!.width).toBeCloseTo(0.4);
    expect(scene.warnings).toEqual([expect.stringMatching(/Delta 1.*conveyor 99/)]);
  });

  it("places the configured working area in the robot's frame in metres", () => {
    const robot = deltaConfig({
      workingArea: { radius: 600, zMin: -1100, zMax: -600, coneHeight: 200, coneBottomRadius: 400 },
    });
    const [area] = buildScene(config(robot), [], 0).workingAreas;

    expect(area).toMatchObject({ robotId: 20 });
    closeTo(area!.transform.position, [1.5, 1.8, 0]);
    closeTo([area!.radius, area!.zMin, area!.zMax, area!.coneHeight, area!.coneBottomRadius], [0.6, -1.1, -0.6, 0.2, 0.4]);
  });
});

describe("scene model: measure mode", () => {
  const belt = conveyorConfig({ pose: { x: 1000, y: 0, z: 800, rx: 0, ry: 0, rz: 90 }, length: 3000, width: 400 });
  const snap = (scene: ReturnType<typeof buildScene>, label: string) => {
    const point = scene.snapPoints.find((p) => p.label === label);
    if (!point) throw new Error(`no snap point "${label}" in: ${scene.snapPoints.map((p) => p.label).join(", ")}`);
    return point;
  };

  it("offers a conveyor's origin, belt surface corners and belt end centre in MCS and belt coordinates", () => {
    const scene = buildScene(config(belt), [], 0);
    const labels = scene.snapPoints.map((p) => p.label);
    expect(labels).toEqual([
      "Infeed · origin",
      "Infeed · start, left",
      "Infeed · start, right",
      "Infeed · end, left",
      "Infeed · end, right",
      "Infeed · end centre",
    ]);
    // Belt +X points along MCS +Y, belt left (+Y) along MCS −X.
    const endLeft = snap(scene, "Infeed · end, left");
    closeTo(endLeft.mcs, [800, 3000, 800]);
    closeTo(endLeft.position, [0.8, 0.8, -3]);
    expect(endLeft.local).toMatchObject({ componentId: 1, componentName: "Infeed" });
    closeTo(endLeft.local.point, [3000, 200, 0]);
    expect(endLeft).toMatchObject({ layer: "structure", moving: false });
    closeTo(snap(scene, "Infeed · origin").mcs, [1000, 0, 800]);
  });

  it("marks a zone's allocation area from the zone start up to the allocation limit", () => {
    const belt = conveyorConfig({ pose: { x: 1000, y: 0, z: 800, rx: 0, ry: 0, rz: 90 }, width: 400 });
    const robot = deltaConfig({
      zones: [
        { conveyorId: 1, start: 1200, end: 1800, allocationOffset: 200, ccsOffset: 0, startY: 0, endY: 0 },
        { conveyorId: 1, start: 2000, end: 2400, allocationOffset: 0, ccsOffset: 0, startY: 0, endY: 0 },
      ],
    });
    const scene = buildScene(config(belt, robot), [], 0);

    const [pick, place] = scene.zones;
    // Belt x = 1200..1600 in a zone centred at 1500: centre −100 mm, limit +100 mm.
    expect(pick!.allocation!.centre).toBeCloseTo(-0.1);
    expect(pick!.allocation!.length).toBeCloseTo(0.4);
    expect(pick!.allocation!.limit).toBeCloseTo(0.1);
    expect(place!.allocation).toBeNull();
    const limit = snap(scene, "Delta 1 zone on Infeed · allocation limit, left");
    closeTo(limit.local.point, [1600, 200, 0]);
    expect(limit.layer).toBe("zones");
  });

  it("clamps an allocation offset longer than the zone to the zone start", () => {
    const robot = deltaConfig({ zones: [{ conveyorId: 1, start: 1200, end: 1800, allocationOffset: 900, ccsOffset: 0, startY: 0, endY: 0 }] });
    const [zone] = buildScene(config(belt, robot), [], 0).zones;

    expect(zone!.allocation!.length).toBeCloseTo(0);
  });

  it("draws a Delta's limit area as a box in its base frame with corner snap points", () => {
    const robot = deltaConfig({
      pose: { x: 1500, y: 0, z: 1800, rx: 0, ry: 0, rz: 90 },
      limitArea: { xMin: -500, xMax: 300, yMin: -700, yMax: 700, zMin: -1400, zMax: -600 },
    });
    const scene = buildScene(config(belt, robot), [], 0);

    const [area] = scene.limitAreas;
    expect(area!.robotId).toBe(20);
    // Centre (−100, 0, −1000) in the base frame, turned by 90° about Z: MCS (1500, −100, 800).
    closeTo(area!.transform.position, [1.5, 0.8, 0.1]);
    closeTo(area!.size, [0.8, 1.4, 0.8]);
    const corner = snap(scene, "Delta 1 limit area · bottom, Y min, X max");
    closeTo(corner.local.point, [300, -700, -1400]);
    closeTo(corner.mcs, [2200, 300, 400]);
    expect(corner.layer).toBe("limitAreas");
  });

  it("draws an XTS gantry's limit area as a box in its frame, like a Delta's", () => {
    const gantry = gantryConfig({ limitArea: { xMin: 0, xMax: 200, yMin: 500, yMax: 1500, zMin: -600, zMax: -400 } });
    const scene = buildScene(config(belt, gantry), [], 0);
    const [area] = scene.limitAreas;
    expect(area!.robotId).toBe(30);
    // Centre (100, 1000, −500) in the gantry frame, turned by 90° about Z: MCS (2000, −400, 1000).
    closeTo(rendererToMcs(area!.transform.position), [2000, -400, 1000], 4);
    closeTo(area!.size, [0.2, 1, 0.2]);
    const corner = snap(scene, "IDH limit area · bottom, Y min, X max");
    closeTo(corner.local.point, [200, 500, -600]);
    closeTo(corner.mcs, [2500, -300, 900]);
    expect(corner.layer).toBe("limitAreas");
  });

  it("draws a Cartesian robot's limit area flat where its bounds are equal, with its corners once", () => {
    const robot = cartesianConfig({
      axes: "xz",
      limitArea: { xMin: 100, xMax: 900, yMin: 0, yMax: 0, zMin: -500, zMax: -100 },
    });
    const scene = buildScene(config(belt, robot), [], 0);
    const [area] = scene.limitAreas;
    expect(area!.robotId).toBe(50);
    closeTo(rendererToMcs(area!.transform.position), [6500, 0, 1700], 4);
    closeTo(area!.size, [0.8, 0.001, 0.4]);
    const corners = scene.snapPoints.filter((p) => p.label.startsWith("Cartesian limit area"));
    expect(corners).toHaveLength(4);
    closeTo(snap(scene, "Cartesian limit area · top, X max").mcs, [6900, 0, 1900]);
  });

  it("has no limit area for robots without one, and none for an XTS loop", () => {
    expect(buildScene(config(belt, gantryConfig(), cartesianConfig(), loopConfig()), [], 0).limitAreas).toEqual([]);
  });

  it("has no limit area for a Delta without one", () => {
    expect(buildScene(config(belt, deltaConfig()), [], 0).limitAreas).toEqual([]);
  });

  it("offers the corners of a zone on its conveyor, in belt coordinates", () => {
    const robot = deltaConfig({ zones: [{ conveyorId: 1, start: 1200, end: 1800, allocationOffset: 0, ccsOffset: 0, startY: 0, endY: 0 }] });
    const corner = snap(buildScene(config(belt, robot), [], 0), "Delta 1 zone on Infeed · start, right");
    closeTo(corner.mcs, [1200, 1200, 800]);
    expect(corner.local.componentName).toBe("Infeed");
    closeTo(corner.local.point, [1200, -200, 0]);
    expect(corner.layer).toBe("zones");
  });

  it("offers a Delta's base, shoulders and actual TCP in the robot's base frame", () => {
    const tcp = { x: 1500, y: 100, z: 1000 };
    const scene = buildScene(config(deltaConfig()), [snapshot(0, [deltaState(tcp, { ...tcp, x: 1510 })])], 0);
    closeTo(snap(scene, "Delta 1 · base").mcs, [1500, 0, 1800]);
    closeTo(snap(scene, "Delta 1 · shoulder 1").mcs, [1700, 0, 1800]);
    closeTo(snap(scene, "Delta 1 · shoulder 2").local.point, [-100, 173.20508075688772, 0]);
    const actual = snap(scene, "Delta 1 · TCP");
    closeTo(actual.mcs, [1500, 100, 1000]);
    closeTo(actual.local.point, [0, 100, -800]);
    expect(actual).toMatchObject({ moving: true, layer: "structure" });
    expect(scene.snapPoints.filter((p) => /setpoint/i.test(p.label))).toEqual([]);
  });

  it("offers the working area's top, bottom and cone bottom centres", () => {
    const robot = deltaConfig({
      workingArea: { radius: 600, zMin: -1100, zMax: -600, coneHeight: 200, coneBottomRadius: 400 },
    });
    const scene = buildScene(config(robot), [], 0);
    closeTo(snap(scene, "Delta 1 working area · top").mcs, [1500, 0, 1200]);
    closeTo(snap(scene, "Delta 1 working area · bottom").mcs, [1500, 0, 700]);
    const cone = snap(scene, "Delta 1 working area · cone bottom");
    closeTo(cone.mcs, [1500, 0, 500]);
    closeTo(cone.local.point, [0, 0, -1300]);
    expect(cone.layer).toBe("workingAreas");

    const noCone = buildScene(config(deltaConfig()), [], 0);
    expect(noCone.snapPoints.map((p) => p.label)).not.toContain("Delta 1 working area · cone bottom");
  });

  it("offers a product's bottom corners and bottom centre, rotated with the product", () => {
    const straight = conveyorConfig();
    const p = product({ latchPose: { x: 1000, y: 0, z: 0, rz: 90 } });
    const scene = buildScene(config(straight), [snapshot(0, [conveyorState(0, [p])])], 0);

    // 100 × 80 mm product turned by 90°: its front (local +X) points along MCS +Y, its left along MCS −X.
    const frontLeft = snap(scene, "Product #7 · front left");
    closeTo(frontLeft.mcs, [960, 50, 800]);
    closeTo(frontLeft.local.point, [960, 50, 0]);
    expect(frontLeft).toMatchObject({ moving: true, layer: "structure" });
    expect(frontLeft.local.componentName).toBe("Infeed");
    closeTo(snap(scene, "Product #7 · bottom centre").mcs, [1000, 0, 800]);
    expect(scene.snapPoints.filter((s) => s.label.startsWith("Product #7"))).toHaveLength(5);
  });

  it("draws round and pouch products with their shape and offers their centre and side points instead of corners", () => {
    const belt = conveyorConfig({
      productTypes: [
        { id: 1, length: 100, width: 80, height: 40, shape: "box", cornerRadius: 0 },
        { id: 2, length: 90, width: 60, height: 50, shape: "cylinder", cornerRadius: 0 },
        { id: 3, length: 140, width: 90, height: 40, shape: "roundedBox", cornerRadius: 20 },
      ],
    });
    const can = { ...product({ latchPose: { x: 1000, y: 0, z: 0, rz: 0 } }), id: 7, productType: 2 };
    const pouch = { ...product({ latchPose: { x: 2000, y: 0, z: 0, rz: 0 } }), id: 8, productType: 3 };
    const scene = buildScene(config(belt), [snapshot(0, [conveyorState(0, [can, pouch])])], 0);

    expect(scene.products.map((p) => [p.productId, p.shape, p.cornerRadius])).toEqual([
      [7, "cylinder", 0],
      [8, "roundedBox", 0.02],
    ]);
    // An oval can: 90 mm along the belt, 60 mm across.
    expect(scene.snapPoints.filter((s) => s.label.startsWith("Product #7")).map((s) => s.label).sort()).toEqual([
      "Product #7 · back",
      "Product #7 · bottom centre",
      "Product #7 · front",
      "Product #7 · left",
      "Product #7 · right",
    ]);
    closeTo(snap(scene, "Product #7 · front").mcs, [1045, 0, 800]);
    closeTo(snap(scene, "Product #7 · left").mcs, [1000, 30, 800]);
    closeTo(snap(scene, "Product #8 · back").mcs, [1930, 0, 800]);
    closeTo(snap(scene, "Product #8 · right").mcs, [2000, -45, 800]);
    expect(scene.snapPoints.some((s) => s.label === "Product #8 · front left")).toBe(false);
  });

  it("draws a product type without a shape, as in recordings made before shapes, as a box", () => {
    const belt = conveyorConfig({ productTypes: [{ id: 1, length: 100, width: 80, height: 40 } as ProductType] });
    const scene = buildScene(config(belt), [snapshot(0, [conveyorState(0, [product()])])], 0);
    expect(scene.products.map((p) => [p.shape, p.cornerRadius])).toEqual([["box", 0]]);
    expect(scene.snapPoints.some((s) => s.label === "Product #7 · front left")).toBe(true);
  });

  it("offers a carried product at the TCP but not its placeholder", () => {
    const robot = deltaConfig();
    const picked = product({ state: "picked", lastClientId: 20 });
    const tcp = { x: 1500, y: 0, z: 1000 };
    const scene = buildScene(config(conveyorConfig(), robot), [snapshot(0, [conveyorState(0, [picked]), deltaState(tcp)])], 0);
    const productPoints = scene.snapPoints.filter((s) => s.label.startsWith("Product #7"));
    expect(productPoints).toHaveLength(5);
    // Bottom of a 40 mm product whose top touches the TCP.
    closeTo(snap(scene, "Product #7 · bottom centre").mcs, [1500, 0, 960]);
  });

  it("does not offer snap points of hidden layers", () => {
    const robot = deltaConfig({
      zones: [{ conveyorId: 1, start: 0, end: 500, allocationOffset: 0, ccsOffset: 0, startY: 0, endY: 0 }],
      limitArea: { xMin: -500, xMax: 500, yMin: -700, yMax: 700, zMin: -1400, zMax: -600 },
    });
    const points = buildScene(config(belt, robot), [], 0).snapPoints;
    const layersOf = (shown: typeof points) => new Set(shown.map((p) => p.layer));

    expect(layersOf(availableSnapPoints(points, { zones: true, workingAreas: true, limitAreas: true }))).toEqual(
      new Set(["structure", "zones", "workingAreas", "limitAreas"]),
    );
    expect(layersOf(availableSnapPoints(points, { zones: false, workingAreas: true, limitAreas: false }))).toEqual(
      new Set(["structure", "workingAreas"]),
    );
    expect(layersOf(availableSnapPoints(points, { zones: false, workingAreas: false, limitAreas: false }))).toEqual(
      new Set(["structure"]),
    );
  });

  it("lists every conveyor's and Delta's origin frame", () => {
    const scene = buildScene(config(belt, deltaConfig()), [], 0);
    expect(scene.origins.map((o) => [o.componentId, o.name])).toEqual([
      [1, "Infeed"],
      [20, "Delta 1"],
    ]);
    closeTo(scene.origins[0]!.transform.position, [1, 0.8, 0]);
    closeTo(scene.origins[1]!.transform.position, [1.5, 1.8, 0]);
  });
});

function straight(length = 250): TrackModule {
  return { kind: "straight", length };
}

/** Eight straight modules (2000 mm), two left curve modules, eight back, two curve modules down to the start. */
const LOOP_MODULES: TrackModule[] = [0, 1].flatMap(() => [
  ...Array.from({ length: 8 }, () => straight()),
  { kind: "curveLeft" as const, length: 250 },
  { kind: "curveLeft" as const, length: 250 },
]);

function gantryConfig(overrides: Partial<XtsGantryConfig> = {}): XtsGantryConfig {
  return {
    type: "xtsGantry",
    id: 30,
    sourceId: "plc1",
    name: "IDH",
    // Turned by 90°: the track (local +Y) runs along MCS −X, the X axes (local +X) along MCS +Y.
    pose: { x: 3000, y: -500, z: 1500, rx: 0, ry: 0, rz: 90 },
    modules: [straight(1000), straight(1000), straight(1000)],
    xMin: -50,
    xMax: 300,
    zMin: -200,
    zMax: 0,
    toolOffsetX: 150,
    toolOffsetZ: -400,
    moverLength: 155,
    moverWidth: 80,
    limitArea: null,
    tcpLimitArea: null,
    zones: [],
    fingers: [],
    originShift: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

function gantryState(z: number, movers: GantryMover[]): StateMessage["components"][number] {
  return { type: "xtsGantry", id: 30, timestamp: "0", z, movers, modules: [], fault: null };
}

const mover1: GantryMover = { id: 1, position: 250, x: 80, gripperActive: true, fingers: [], fault: null };

describe("scene model: XTS gantry", () => {
  const scene = buildScene(config(gantryConfig()), [snapshot(0, [gantryState(-100, [mover1])])], 0);
  const [g] = scene.gantries;

  it("lifts the whole track with the common Z axis", () => {
    expect(g).toMatchObject({ id: 30, name: "IDH" });
    closeTo([g!.moverLength, g!.moverWidth], [0.155, 0.08]);
    // Track start at Z = −100: MCS (3000, −500, 1400).
    closeTo(g!.track.position, [3, 1.4, 0.5]);
  });

  it("draws each track module where the one before it ends, along the track's local +Y", () => {
    expect(g!.modules.map((m) => [m.index, m.length, m.radius])).toEqual([
      [1, 1, 0],
      [2, 1, 0],
      [3, 1, 0],
    ]);
    // Relative to the track: module 2 starts 1000 mm along local +Y, renderer −Z.
    closeTo(g!.modules[1]!.transform.position, [0, 0, -1]);
    // Its local +X runs along the track.
    closeTo(rotate(g!.modules[1]!.transform.quaternion, [1, 0, 0]), [0, 0, -1]);
  });

  it("places each mover on the track and its gripper flange at X + offset, turned with the gantry", () => {
    const [m] = g!.movers;
    expect(m).toMatchObject({ id: 1, gripperActive: true });
    // Mover at track position 250: MCS (2750, −500, 1400).
    closeTo(m!.carriage, [2.75, 1.4, 0.5]);
    // X arm end above the gripper: local (230, 250, −100) -> MCS (2750, −270, 1400).
    closeTo(m!.armEnd, [2.75, 1.4, 0.27]);
    // Gripper flange: local (230, 250, −500) -> MCS (2750, −270, 1000).
    closeTo(m!.tip.position, [2.75, 1, 0.27]);
    // Pose rz 90°: the flange's local +X points along MCS +Y.
    closeTo(rotate(m!.tip.quaternion, [1, 0, 0]), [0, 0, -1]);
  });

  it("draws the reachable gripper volume as a box in the working-area layer", () => {
    const [area] = scene.boxAreas;
    expect(area!.robotId).toBe(30);
    // X 100..450, Y 0..3000, Z −600..−400 in the gantry frame.
    closeTo(area!.transform.position, [1.5, 1, 0.225]);
    closeTo(area!.size, [0.35, 3, 0.2]);
  });

  it("hangs a picked product without finger below the gripper flange of its mover", () => {
    const belt = conveyorConfig();
    const picked = product({ state: "picked", lastClientId: 30, moverId: 1 });
    const products = buildScene(
      config(belt, gantryConfig()),
      [snapshot(0, [conveyorState(0, [picked]), gantryState(-100, [mover1])])],
      0,
    ).products;
    const carried = products.find((p) => p.display === "atTcp");
    // 40 mm product, top at the gripper flange MCS (2750, −270, 1000).
    closeTo(carried!.transform.position, [2.75, 0.98, 0.27]);
  });

  it("offers track start, module boundaries, track end and the gripper flanges as snap points", () => {
    const byLabel = new Map(scene.snapPoints.map((p) => [p.label, p]));
    closeTo(byLabel.get("IDH · track start")!.mcs, [3000, -500, 1400]);
    closeTo(byLabel.get("IDH · module 1 / 2")!.mcs, [2000, -500, 1400]);
    closeTo(byLabel.get("IDH · track end")!.mcs, [0, -500, 1400]);
    const tcp = byLabel.get("IDH · mover 1 flange")!;
    closeTo(tcp.mcs, [2750, -270, 1000]);
    closeTo(tcp.local.point, [230, 250, -500]);
    expect(tcp.moving).toBe(true);
    expect(scene.origins.map((o) => o.name)).toContain("IDH");
  });

  it("resolves its zones onto the referenced conveyor", () => {
    const zoned = buildScene(
      config(conveyorConfig(), gantryConfig({ zones: [{ conveyorId: 1, start: 0, end: 800, allocationOffset: 0, ccsOffset: 0, startY: 0, endY: 0 }] })),
      [],
      0,
    );
    expect(zoned.zones).toEqual([expect.objectContaining({ componentId: 30, conveyorId: 1 })]);
  });
});

function cartesianConfig(overrides: Partial<CartesianConfig> = {}): CartesianConfig {
  return {
    type: "cartesian",
    id: 50,
    sourceId: "plc1",
    name: "Cartesian",
    pose: { x: 6000, y: 0, z: 2000, rx: 0, ry: 0, rz: 0 },
    axes: "xyz",
    xMin: 0,
    xMax: 1200,
    yMin: 0,
    yMax: 1000,
    zMin: -600,
    zMax: 0,
    railHeight: 1200,
    limitArea: null,
    tcpLimitArea: null,
    zones: [],
    fingers: [],
    originShift: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

function cartesianState(overrides: Partial<CartesianState> = {}): CartesianState {
  return {
    type: "cartesian",
    id: 50,
    timestamp: "0",
    x: 600,
    y: 250,
    z: -400,
    gripperActive: true,
    fingers: [],
    fault: null,
    ...overrides,
  };
}

/** Flange at local (600, 250, −400). */
const CARTESIAN_FLANGE: Vec3 = [6600, 250, 1600];

describe("scene model: Cartesian robot", () => {
  const scene = buildScene(config(cartesianConfig()), [snapshot(0, [cartesianState()])], 0);
  const [robot] = scene.cartesians;
  const part = (key: string) => robot!.parts.find((p) => p.key === key)!;

  it("places the gripper flange at the axis values, turned with the robot", () => {
    expect(robot).toMatchObject({ id: 50, name: "Cartesian", gripperActive: true });
    expect(robot!.axes).toEqual({ x: 600, y: 250, z: -400 });
    closeTo(rendererToMcs(robot!.flange!.position), CARTESIAN_FLANGE, 4);
    closeTo(rotate(robot!.flange!.quaternion, [1, 0, 0]), [1, 0, 0]);
  });

  it("moves the bridge with Y, the carriage with X and Y, and ends the column at the flange", () => {
    // Bridge on top of the rails (top at 1200 above the origin), spanning the X stroke plus margins and rails.
    closeTo(rendererToMcs(part("bridge").transform.position), [6600, 250, 3250], 4);
    closeTo(part("bridge").size, [1.52, 0.14, 0.1]);
    closeTo(rendererToMcs(part("carriage").transform.position), [6600, 250, 3250], 4);
    // Column 1200 + 100 + 600 long, bottom at the flange Z = −400.
    closeTo(part("column").size, [0.09, 0.09, 1.9]);
    closeTo(rendererToMcs(part("column").transform.position), [6600, 250, 1600 + 950], 4);
    // Rails outside the X stroke, along Y beyond the stroke by margin and half the bridge.
    closeTo(rendererToMcs(part("rail left").transform.position), [5880, 500, 3160], 4);
    closeTo(part("rail right").size, [0.08, 1.38, 0.08]);
  });

  it("draws the reachable flange volume as a box in the working-area layer", () => {
    const [area] = scene.boxAreas;
    expect(area!.robotId).toBe(50);
    // X 0..1200, Y 0..1000, Z −600..0 in the robot frame.
    closeTo(rendererToMcs(area!.transform.position), [6600, 500, 1700], 4);
    closeTo(area!.size, [1.2, 1, 0.6]);
  });

  it("hangs a picked product without finger at the flange", () => {
    const picked = product({ state: "picked", lastClientId: 50, moverId: 0 });
    const products = buildScene(
      config(conveyorConfig(), cartesianConfig()),
      [snapshot(0, [conveyorState(0, [picked]), cartesianState()])],
      0,
    ).products;
    const carried = products.find((p) => p.display === "atTcp")!;
    // 40 mm product: its centre lies 20 mm below the flange.
    closeTo(rendererToMcs(carried.transform.position), [6600, 250, 1580], 4);
  });

  it("offers origin, rail ends, stroke-space corners and the flange as snap points", () => {
    const byLabel = new Map(scene.snapPoints.map((p) => [p.label, p]));
    closeTo(byLabel.get("Cartesian · origin")!.mcs, [6000, 0, 2000]);
    closeTo(byLabel.get("Cartesian · rail right, end")!.mcs, [7320, 1190, 3200]);
    const corner = byLabel.get("Cartesian stroke space · bottom, start, X min")!;
    closeTo(corner.mcs, [6000, 0, 1400]);
    expect(corner.layer).toBe("workingAreas");
    const flange = byLabel.get("Cartesian · flange")!;
    closeTo(flange.mcs, CARTESIAN_FLANGE);
    closeTo(flange.local.point, [600, 250, -400]);
    expect(flange.moving).toBe(true);
    expect(byLabel.has("Cartesian · TCP")).toBe(false);
    expect(scene.origins.map((o) => o.name)).toContain("Cartesian");
  });

  it("interpolates the axes", () => {
    const mid = buildScene(
      config(cartesianConfig()),
      [snapshot(0, [cartesianState({ x: 0 })]), snapshot(20, [cartesianState({ x: 100 })])],
      10,
    ).cartesians[0]!;
    expect(mid.axes!.x).toBeCloseTo(50);
  });

  it("draws the robot without flange before the first state", () => {
    const [idle] = buildScene(config(cartesianConfig()), [], 0).cartesians;
    expect(idle!.flange).toBeNull();
    expect(idle!.axes).toBeNull();
    expect(idle!.parts.map((p) => p.key)).toEqual(["rail left", "rail right", "bridge", "carriage", "column"]);
  });
});

describe("scene model: Cartesian robot without a Y axis (X, Z)", () => {
  // The state's y = 250 is ignored: Y is always 0.
  const scene = buildScene(config(cartesianConfig({ axes: "xz" })), [snapshot(0, [cartesianState()])], 0);
  const [robot] = scene.cartesians;
  const part = (key: string) => robot!.parts.find((p) => p.key === key)!;
  const byLabel = new Map(scene.snapPoints.map((p) => [p.label, p]));

  it("hangs carriage and column from a fixed beam at Y = 0 instead of rails and bridge", () => {
    expect(robot!.parts.map((p) => p.key)).toEqual(["beam", "carriage", "column"]);
    expect(robot!.axes).toEqual({ x: 600, y: 0, z: -400 });
    closeTo(rendererToMcs(robot!.flange!.position), [6600, 0, 1600], 4);
    // Beam on top of railHeight, spanning the X stroke plus margins.
    closeTo(rendererToMcs(part("beam").transform.position), [6600, 0, 3250], 4);
    closeTo(part("beam").size, [1.44, 0.14, 0.1]);
    closeTo(rendererToMcs(part("carriage").transform.position), [6600, 0, 3250], 4);
  });

  it("draws the reachable flange area as a flat rectangle in the X-Z plane", () => {
    const [area] = scene.boxAreas;
    closeTo(rendererToMcs(area!.transform.position), [6600, 0, 1700], 4);
    closeTo(area!.size, [1.2, 0.001, 0.6]);
  });

  it("offers the beam ends and four stroke-space corners instead of rail ends", () => {
    closeTo(byLabel.get("Cartesian · beam, X min end")!.mcs, [5880, 0, 3200]);
    expect([...byLabel.keys()].some((l) => l.includes("rail"))).toBe(false);
    const corners = [...byLabel.keys()].filter((l) => l.startsWith("Cartesian stroke space"));
    expect(corners).toHaveLength(4);
    closeTo(byLabel.get("Cartesian stroke space · top, X max")!.mcs, [7200, 0, 2000]);
  });
});

describe("scene model: Cartesian robot without a Z axis (X, Y)", () => {
  // The state's z = −400 is ignored: the flange stays at zMin = −600.
  const scene = buildScene(config(cartesianConfig({ axes: "xy" })), [snapshot(0, [cartesianState()])], 0);
  const [robot] = scene.cartesians;
  const part = (key: string) => robot!.parts.find((p) => p.key === key)!;
  const byLabel = new Map(scene.snapPoints.map((p) => [p.label, p]));

  it("keeps rails and bridge and ends a column of fixed length at zMin", () => {
    expect(robot!.parts.map((p) => p.key)).toEqual(["rail left", "rail right", "bridge", "carriage", "column"]);
    expect(robot!.axes).toEqual({ x: 600, y: 250, z: -600 });
    closeTo(rendererToMcs(robot!.flange!.position), [6600, 250, 1400], 4);
    closeTo(part("column").size, [0.09, 0.09, 1.9]);
    closeTo(rendererToMcs(part("column").transform.position), [6600, 250, 1400 + 950], 4);
  });

  it("draws the reachable flange area as a flat rectangle at zMin", () => {
    const [area] = scene.boxAreas;
    closeTo(rendererToMcs(area!.transform.position), [6600, 500, 1400], 4);
    closeTo(area!.size, [1.2, 1, 0.001]);
    const corners = [...byLabel.keys()].filter((l) => l.startsWith("Cartesian stroke space"));
    expect(corners).toHaveLength(4);
    closeTo(byLabel.get("Cartesian stroke space · end, X max")!.mcs, [7200, 1000, 1400]);
  });
});

function loopConfig(overrides: Partial<XtsLoopConfig> = {}): XtsLoopConfig {
  return {
    type: "xtsLoop",
    id: 40,
    sourceId: "plc1",
    name: "Fxx",
    pose: { x: 5000, y: 0, z: 900, rx: 0, ry: 0, rz: 0 },
    modules: LOOP_MODULES,
    toolOffset: 120,
    moverLength: 100,
    moverWidth: 60,
    zones: [],
    fingers: [],
    originShift: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

function loopState(movers: { id: number; position: number }[]): StateMessage["components"][number] {
  return {
    type: "xtsLoop",
    id: 40,
    timestamp: "0",
    movers: movers.map((m) => ({ ...m, fingers: [], fault: null })),
    modules: [],
    fault: null,
  };
}

/** Radius of a 250 mm quarter curve: 2 · 250 / π. */
const R = 500 / Math.PI;
/** 2 × (8 straight + 2 curve modules) × 250 mm. */
const PERIMETER = 5000;

describe("scene model: XTS loop", () => {
  const moverAt = (position: number) =>
    buildScene(config(loopConfig()), [snapshot(0, [loopState([{ id: 11, position }])])], 0).loops[0]!.movers[0]!;

  it("places a mover on the lower straight with its tool point below it", () => {
    const m = moverAt(500);
    closeTo(m.transform.position, [5.5, 0.9, 0]);
    closeTo(m.tool, [5.5, 0.78, 0]);
    closeTo(rotate(m.transform.quaternion, [1, 0, 0]), [1, 0, 0]);
  });

  it("follows the far curve modules as quarter circles, turning the mover with the tangent", () => {
    // At the end of the first curve module: a quarter circle ahead and up, at its centre's height.
    const m = moverAt(2250);
    closeTo(m.transform.position, [(7000 + R) / 1000, (900 + R) / 1000, 0]);
    // Tangent points up; the tool point lies outwards along +X.
    closeTo(rotate(m.transform.quaternion, [1, 0, 0]), [0, 1, 0]);
    closeTo(m.tool, [(7000 + R + 120) / 1000, (900 + R) / 1000, 0]);
  });

  it("returns along the upper straight against the conveying direction", () => {
    const m = moverAt(3000);
    closeTo(m.transform.position, [6.5, (900 + 2 * R) / 1000, 0]);
    closeTo(m.tool, [6.5, (900 + 2 * R + 120) / 1000, 0]);
    closeTo(rotate(m.transform.quaternion, [1, 0, 0]), [-1, 0, 0]);
  });

  it("turns a right curve module the other way", () => {
    const modules: TrackModule[] = [straight(), { kind: "curveRight", length: 250 }, straight()];
    const m = buildScene(config(loopConfig({ modules })), [snapshot(0, [loopState([{ id: 11, position: 500 }])])], 0)
      .loops[0]!.movers[0]!;
    // Below the straight, heading down.
    closeTo(m.transform.position, [(5250 + R) / 1000, (900 - R) / 1000, 0]);
    closeTo(rotate(m.transform.quaternion, [1, 0, 0]), [0, -1, 0]);
  });

  it("draws every track module with its curve radius and turn", () => {
    const [loop] = buildScene(config(loopConfig()), [], 0).loops;
    expect(loop!.modules).toHaveLength(20);
    const curve = loop!.modules[8]!;
    expect(curve).toMatchObject({ index: 9, turn: 1 });
    closeTo([curve.length, curve.radius], [0.25, R / 1000]);
    // Relative to the loop's base: module 9 starts at the end of the lower straight.
    closeTo(curve.transform.position, [2, 0, 0]);
    // The upper straight's first module starts 2R above it, running back along −X.
    const upper = loop!.modules[10]!;
    closeTo(upper.transform.position, [2, (2 * R) / 1000, 0]);
    closeTo(rotate(upper.transform.quaternion, [1, 0, 0]), [-1, 0, 0]);
    expect(buildScene(config(loopConfig()), [], 0).warnings).toEqual([]);
  });

  it("warns when the modules of a loop do not close the track", () => {
    const open = buildScene(config(loopConfig({ modules: [straight(), straight()] })), [], 0);
    expect(open.warnings).toEqual(["Fxx: the track modules do not close the loop (500 mm apart)"]);
  });

  it("wraps positions around the perimeter", () => {
    closeTo(moverAt(PERIMETER + 500).transform.position, moverAt(500).transform.position);
    closeTo(moverAt(-100).transform.position, moverAt(PERIMETER - 100).transform.position);
    // Just before the start, on the near curve: behind the origin, slightly above it.
    expect(moverAt(-100).transform.position[0]).toBeLessThan(5);
  });

  it("interpolates across the wrap the short way", () => {
    const snapshots = [
      snapshot(0, [loopState([{ id: 11, position: PERIMETER - 50 }])]),
      snapshot(20, [loopState([{ id: 11, position: 50 }])]),
    ];
    const m = buildScene(config(loopConfig()), snapshots, 10).loops[0]!.movers[0]!;
    closeTo(m.transform.position, [5, 0.9, 0]);
  });

  it("hangs a picked product below the tool point of its mover", () => {
    const picked = product({ state: "picked", lastClientId: 40, moverId: 11 });
    const products = buildScene(
      config(conveyorConfig(), loopConfig()),
      [snapshot(0, [conveyorState(0, [picked]), loopState([{ id: 11, position: 500 }])])],
      0,
    ).products;
    closeTo(products.find((p) => p.display === "atTcp")!.transform.position, [5.5, 0.76, 0]);
  });

  it("offers the module boundaries, the curve centres and the movers' tool points as snap points", () => {
    const scene = buildScene(config(loopConfig()), [snapshot(0, [loopState([{ id: 11, position: 500 }])])], 0);
    const byLabel = new Map(scene.snapPoints.map((p) => [p.label, p]));
    closeTo(byLabel.get("Fxx · track start")!.mcs, [5000, 0, 900]);
    closeTo(byLabel.get("Fxx · module 8 / 9")!.mcs, [7000, 0, 900]);
    closeTo(byLabel.get("Fxx · module 10 / 11")!.mcs, [7000, 0, 900 + 2 * R]);
    closeTo(byLabel.get("Fxx · module 9 curve centre")!.mcs, [7000, 0, 900 + R]);
    // A closed track ends where it starts.
    expect(byLabel.has("Fxx · track end")).toBe(false);
    expect(byLabel.has("Fxx · module 20 / 1")).toBe(false);
    const tool = byLabel.get("Fxx · mover 11 tool")!;
    closeTo(tool.mcs, [5500, 0, 780]);
    expect(tool.moving).toBe(true);
    expect(scene.origins.map((o) => o.name)).toContain("Fxx");
  });
});

describe("measuring point chain", () => {
  it("gives each point after the first its signed offset along X, Y and Z to the previous point", () => {
    const rows = measureChain([
      [0, 0, 0],
      [300, 400, 0],
      [300, 250, 120],
    ]);
    expect(rows[0]).toEqual({ delta: undefined });
    closeTo(rows[1]!.delta!, [300, 400, 0]);
    closeTo(rows[2]!.delta!, [0, -150, 120]);
  });

  it("formats points as X;Y;Z and the whole list as CSV with the offsets along X, Y and Z, all with 0.1 mm", () => {
    expect(formatPointCopy([1000, -2.25, 800.04])).toBe("1000.0;-2.3;800.0");
    expect(
      pointsCsv([
        { id: 1, label: "Infeed · origin", mcs: [1000, 0, 800] },
        { id: 2, label: "Infeed · end, left", mcs: [800, 3000, 800] },
      ]),
    ).toBe(
      "#;label;x;y;z;dx;dy;dz\n1;Infeed · origin;1000.0;0.0;800.0;;;\n2;Infeed · end, left;800.0;3000.0;800.0;-200.0;3000.0;0.0",
    );
  });
});

/** Rotate v by unit quaternion q = [x, y, z, w]. */
function rotate([x, y, z, w]: readonly number[], [vx, vy, vz]: Vec3): Vec3 {
  const ix = w! * vx + y! * vz - z! * vy;
  const iy = w! * vy + z! * vx - x! * vz;
  const iz = w! * vz + x! * vy - y! * vx;
  const iw = -x! * vx - y! * vy - z! * vz;
  return [
    ix * w! + iw * -x! + iy * -z! - iz * -y!,
    iy * w! + iw * -y! + iz * -x! - ix * -z!,
    iz * w! + iw * -z! + ix * -y! - iy * -x!,
  ];
}

describe("scene model: faults", () => {
  it("marks a faulted mover, labels it above its carriage and lists it under its gantry", () => {
    const faulty: GantryMover = { ...mover1, id: 2, position: 600, fault: { message: "following error" } };
    const scene = buildScene(config(gantryConfig()), [snapshot(0, [gantryState(-100, [mover1, faulty])])], 0);

    const g = scene.gantries[0]!;
    expect(g.fault).toBeNull();
    expect(g.movers.map((m) => m.fault)).toEqual([null, "following error"]);
    expect(scene.faultLabels).toHaveLength(1);
    expect(scene.faultLabels[0]).toMatchObject({ componentId: 30, part: "Mover 2", message: "following error" });
    // Carriage at track position 600: MCS (2400, −500, 1400); the label 200 mm above it.
    closeTo(scene.faultLabels[0]!.position, [2.4, 1.6, 0.5]);
    expect(scene.faults).toEqual([{ componentId: 30, messages: ["Mover 2: following error"], limitViolations: [] }]);
  });

  it("marks a whole faulted component with its fingers and shows 'Fault' for an empty message", () => {
    const robot = deltaConfig({ fingers: [{ diameter: 40, height: 50, offset: onFlange }] });
    const tcp = { x: 1500, y: 0, z: 1800 - HORIZONTAL_DEPTH };
    const state = { ...deltaState(tcp, tcp, 20, [{ pose: { ...tcp, rx: 0, ry: 0, rz: 0 }, poseReported: true, active: false }]), fault: { message: "" } };
    const scene = buildScene(config(robot), [snapshot(0, [state])], 0);

    expect(scene.deltas[0]!.fault).toBe("Fault");
    expect(scene.fingers.map((f) => f.faulted)).toEqual([true]);
    expect(scene.faultLabels).toHaveLength(1);
    expect(scene.faultLabels[0]).toMatchObject({ componentId: 20, part: null, message: "Fault" });
    // 250 mm above the base at MCS (1500, 0, 1800).
    closeTo(scene.faultLabels[0]!.position, [1.5, 2.05, 0]);
    expect(scene.faults).toEqual([{ componentId: 20, messages: ["Fault"], limitViolations: [] }]);
  });

  it("lists the component's own fault before its movers' faults", () => {
    const faulty: GantryMover = { ...mover1, fault: { message: "following error" } };
    const state = { ...gantryState(0, [faulty]), fault: { message: "Z axis error" } };
    const scene = buildScene(config(gantryConfig()), [snapshot(0, [state])], 0);

    expect(scene.gantries[0]!.fault).toBe("Z axis error");
    expect(scene.faults).toEqual([{ componentId: 30, messages: ["Z axis error", "Mover 1: following error"], limitViolations: [] }]);
    expect(scene.faultLabels.map((l) => l.part)).toEqual([null, "Mover 1"]);
  });

  it("marks a faulted track module red, labels it above its middle and lists it under its loop", () => {
    const modules = LOOP_MODULES.map(() => ({ fault: null as { message: string } | null }));
    modules[8] = { fault: { message: "Overtemperature" } };
    const state = { ...loopState([]), modules };
    const scene = buildScene(config(loopConfig()), [snapshot(0, [state])], 0);

    const loop = scene.loops[0]!;
    expect(loop.modules.map((m) => m.fault).filter((f) => f !== null)).toEqual(["Overtemperature"]);
    expect(loop.modules[8]!.fault).toBe("Overtemperature");
    expect(scene.faults).toEqual([{ componentId: 40, messages: ["Module 9: Overtemperature"], limitViolations: [] }]);
    expect(scene.faultLabels).toHaveLength(1);
    expect(scene.faultLabels[0]).toMatchObject({ componentId: 40, part: "Module 9", message: "Overtemperature" });
    // Module 9 is the first quarter curve after the lower straight: its middle lies 45° round it, the label 150 mm above.
    const half = Math.SQRT1_2 * R;
    closeTo(scene.faultLabels[0]!.position, [(7000 + half) / 1000, (900 + R - half + 150) / 1000, 0]);
  });

  it("reads the states of recordings made before protocol 12, which report no track modules", () => {
    const { modules: _, ...old } = loopState([{ id: 11, position: 500 }]) as Extract<StateMessage["components"][number], { type: "xtsLoop" }>;
    const scene = buildScene(config(loopConfig()), [snapshot(0, [old as StateMessage["components"][number]])], 0);
    expect(scene.loops[0]!.modules.every((m) => m.fault === null)).toBe(true);
    expect(scene.loops[0]!.movers).toHaveLength(1);
  });

  it("draws the XTS components of recordings made before protocol 12 without their track", () => {
    const { modules: _, ...oldLoop } = { ...loopConfig(), straightLength: 2000, curveRadius: 250 };
    const { modules: __, ...oldGantry } = { ...gantryConfig(), moduleCount: 3, moduleLength: 1000 };
    const scene = buildScene(
      config(oldLoop as unknown as XtsLoopConfig, oldGantry as unknown as XtsGantryConfig),
      [snapshot(0, [loopState([{ id: 11, position: 500 }]), gantryState(0, [mover1])])],
      0,
    );
    expect(scene.loops[0]!.modules).toEqual([]);
    expect(scene.gantries[0]!.modules).toEqual([]);
    // Movers still stand where their position lies along the start direction.
    closeTo(scene.loops[0]!.movers[0]!.transform.position, [5.5, 0.9, 0]);
  });

  it("takes faults from the earlier snapshot instead of interpolating them", () => {
    const faulty: GantryMover = { ...mover1, fault: { message: "following error" } };
    const snapshots = [snapshot(0, [gantryState(0, [mover1])]), snapshot(20, [gantryState(0, [faulty])])];

    expect(buildScene(config(gantryConfig()), snapshots, 15).gantries[0]!.movers[0]!.fault).toBeNull();
    expect(buildScene(config(gantryConfig()), snapshots, 20).gantries[0]!.movers[0]!.fault).toBe("following error");
  });

  it("keeps a hidden faulted component in the fault list but draws no label for it", () => {
    const state = { ...conveyorState(0, []), fault: { message: "Belt stopped" } };
    const scene = buildScene(config(conveyorConfig()), [snapshot(0, [state])], 0, new Set([1]));

    expect(scene.faultLabels).toEqual([]);
    expect(scene.faults).toEqual([{ componentId: 1, messages: ["Belt stopped"], limitViolations: [] }]);
  });

  it("labels a faulted conveyor above the middle of its belt", () => {
    const state = { ...conveyorState(0, []), fault: { message: "Belt stopped" } };
    const scene = buildScene(config(conveyorConfig()), [snapshot(0, [state])], 0);

    expect(scene.conveyors[0]!.fault).toBe("Belt stopped");
    // Belt from MCS (0, 0, 800) along +X, 3000 long: middle (1500, 0, 800), label 150 mm above it.
    closeTo(scene.faultLabels[0]!.position, [1.5, 0.95, 0]);
  });
});

describe("machine scene: several PLC sources", () => {
  const A = "ads:5.1.2.3.1.1:851";
  const B = "ads:5.1.2.4.1.1:851";
  /** Both PLCs report a conveyor with manifest id 1 (ids are unique per source only), B's 2 m further along Y. */
  const configOf = (sourceId: string, y: number): ConfigMessage => ({
    ...config(conveyorConfig({ sourceId, name: sourceId === A ? "Infeed" : "Outfeed", pose: { x: 0, y, z: 800, rx: 0, ry: 0, rz: 0 } })),
    sourceId,
  });
  const source = (sourceId: string, y: number, snapshots: StateMessage[], renderTime = 0, online = true) => ({
    sourceId,
    config: configOf(sourceId, y),
    snapshots: snapshots.map((m) => ({ ...m, sourceId })),
    renderTime,
    online,
  });
  const belt = (tRel: number, beltPosition: number, fault: string | null = null) =>
    snapshot(tRel, [{ ...conveyorState(beltPosition, [product()]), fault: fault === null ? null : { message: fault } }]);

  it("keeps the components of different sources apart even when they use the same manifest id", () => {
    const machine = buildMachineScene([source(A, 0, [belt(0, 0)]), source(B, 2000, [belt(0, 0)])], new Set());

    expect(machine.sources.map((x) => [x.sourceId, x.scene.conveyors.map((c) => c.name)])).toEqual([
      [A, ["Infeed"]],
      [B, ["Outfeed"]],
    ]);
    closeTo(machine.sources[1]!.scene.conveyors[0]!.transform.position, [0, 0.8, -2]);
    expect(machine.sources.map((x) => x.scene.products.length)).toEqual([1, 1]);
    const keys = machine.snapPoints.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(machine.snapPoints.map((p) => p.sourceId))).toEqual(new Set([A, B]));
  });

  it("interpolates each source on its own timeline", () => {
    // B's PLC clock is unrelated to A's: its tRel axis started at another moment.
    const machine = buildMachineScene(
      [source(A, 0, [belt(0, 0), belt(20, 200)], 10), source(B, 2000, [belt(1000, 0), belt(1020, 400)], 1010)],
      new Set(),
    );

    const productX = machine.sources.map((x) => x.scene.products[0]!.transform.position[0]);
    closeTo(productX, [0.1, 0.2]);
  });

  it("keeps the last config and state of an unreachable source and marks it offline", () => {
    const machine = buildMachineScene([source(A, 0, [belt(0, 0)]), source(B, 2000, [belt(0, 300)], 0, false)], new Set());

    expect(machine.sources.map((x) => x.online)).toEqual([true, false]);
    expect(machine.sources[1]!.scene.conveyors).toHaveLength(1);
    closeTo([machine.sources[1]!.scene.products[0]!.transform.position[0]], [0.3]);
  });

  it("hides a component of one source without hiding the component with the same id of another", () => {
    const machine = buildMachineScene([source(A, 0, []), source(B, 2000, [])], new Set([componentKey(B, 1)]));

    expect(machine.sources.map((x) => x.scene.conveyors.length)).toEqual([1, 0]);
  });

  it("hides every component of a hidden source but still lists its faults", () => {
    const machine = buildMachineScene(
      [source(A, 0, [belt(0, 0)]), source(B, 2000, [belt(0, 0, "Belt jammed")])],
      new Set([B]),
    );

    expect(machine.sources[1]!.scene.conveyors).toEqual([]);
    expect(machine.snapPoints.every((p) => p.sourceId === A)).toBe(true);
    expect(machine.faults).toEqual([{ sourceId: B, componentId: 1, messages: ["Belt jammed"], limitViolations: [] }]);
  });
});

describe("scene model: conveyor coordinate system and origin shift", () => {
  // Belt along MCS +X at height 800.
  const belt = conveyorConfig();
  const pickZone = (overrides: Partial<Zone> = {}): Zone => ({
    conveyorId: 1,
    start: 1200,
    end: 1800,
    allocationOffset: 0,
    ccsOffset: 1500,
    startY: 0,
    endY: 0,
    ...overrides,
  });
  const snapAt = (scene: ReturnType<typeof buildScene>, label: string) => {
    const point = scene.snapPoints.find((p) => p.label === label);
    if (!point) throw new Error(`no snap point "${label}" in: ${scene.snapPoints.map((p) => p.label).join(", ")}`);
    return point;
  };

  it("puts a zone's CCS crosshair at its offset on the belt's centre line, as a zone snap point", () => {
    const scene = buildScene(config(belt, deltaConfig({ zones: [pickZone()] })), [], 0);

    closeTo(scene.zones[0]!.ccs.position, [1.5, 0.8, 0]);
    const ccs = snapAt(scene, "Delta 1 zone on Infeed · CCS");
    closeTo(ccs.mcs, [1500, 0, 800]);
    expect(ccs.layer).toBe("zones");
    expect(scene.warnings).toEqual([]);
  });

  it("draws a zone's CCS outside the zone without a warning while it lies on the belt", () => {
    const scene = buildScene(config(belt, deltaConfig({ zones: [pickZone({ ccsOffset: 2000 })] })), [], 0);

    closeTo(scene.zones[0]!.ccs.position, [2, 0.8, 0]);
    expect(scene.warnings).toEqual([]);
  });

  it("warns when a zone's CCS lies past a belt end, and draws it there", () => {
    const scene = buildScene(config(belt, deltaConfig({ zones: [pickZone({ ccsOffset: 3200 })] })), [], 0);

    closeTo(scene.zones[0]!.ccs.position, [3.2, 0.8, 0]);
    expect(scene.warnings).toEqual(["Delta 1: CCS of the zone on Infeed (3200 mm) lies outside the belt (0 to 3000 mm)"]);
  });

  it("counts a conveyor's belt coordinates from its shifted origin", () => {
    const shifted = conveyorConfig({ originShift: { x: 500, y: 0, z: 0 } });
    const scene = buildScene(config(shifted, deltaConfig({ zones: [pickZone()] })), [], 0);

    // Zone 1200..1800 from the origin 500 mm behind the belt start: centre at 2000 mm from the start.
    closeTo(scene.zones[0]!.transform.position, [2, 0.8, 0]);
    closeTo(scene.zones[0]!.ccs.position, [2, 0.8, 0]);
    const start = snapAt(scene, "Delta 1 zone on Infeed · start, right");
    closeTo(start.mcs, [1700, -200, 800]);
    closeTo(start.local.point, [1200, -200, 0]);
  });

  it("spans the whole belt width when a zone's Y bounds are equal", () => {
    const scene = buildScene(config(belt, deltaConfig({ zones: [pickZone({ startY: 30, endY: 30 })] })), [], 0);

    expect(scene.zones[0]!.width).toBeCloseTo(0.4);
    closeTo(snapAt(scene, "Delta 1 zone on Infeed · start, left").mcs, [1200, 200, 800]);
    closeTo(snapAt(scene, "Delta 1 zone on Infeed · start, right").mcs, [1200, -200, 800]);
  });

  it("bounds a zone across the belt by its Y bounds, given in any order: area, CCS line and snap points", () => {
    const zone = pickZone({ startY: 150, endY: 50, allocationOffset: 200 });
    const scene = buildScene(config(belt, deltaConfig({ zones: [zone] })), [], 0);

    const drawn = scene.zones[0]!;
    // MCS Y 100 is renderer −Z 0.1.
    closeTo(drawn.transform.position, [1.5, 0.8, -0.1]);
    expect(drawn.width).toBeCloseTo(0.1);
    closeTo(drawn.ccs.position, [1.5, 0.8, -0.1]);
    closeTo(snapAt(scene, "Delta 1 zone on Infeed · start, left").mcs, [1200, 150, 800]);
    closeTo(snapAt(scene, "Delta 1 zone on Infeed · end, right").mcs, [1800, 50, 800]);
    closeTo(snapAt(scene, "Delta 1 zone on Infeed · allocation limit, left").mcs, [1600, 150, 800]);
    closeTo(snapAt(scene, "Delta 1 zone on Infeed · CCS").mcs, [1500, 100, 800]);
    expect(scene.warnings).toEqual([]);
  });

  it("counts a zone's Y bounds in the conveyor's coordinate system", () => {
    const shifted = conveyorConfig({ originShift: { x: 0, y: -20, z: 0 } });
    const scene = buildScene(config(shifted, deltaConfig({ zones: [pickZone({ startY: 0, endY: 100 })] })), [], 0);

    const left = snapAt(scene, "Delta 1 zone on Infeed · start, left");
    closeTo(left.mcs, [1200, 80, 800]);
    closeTo(left.local.point, [1200, 100, 0]);
    closeTo(snapAt(scene, "Delta 1 zone on Infeed · start, right").mcs, [1200, -20, 800]);
  });

  it("draws a zone reaching past the belt's sides as reported, without a warning", () => {
    const scene = buildScene(config(belt, deltaConfig({ zones: [pickZone({ startY: -300, endY: 100 })] })), [], 0);

    expect(scene.zones[0]!.width).toBeCloseTo(0.4);
    closeTo(scene.zones[0]!.transform.position, [1.5, 0.8, 0.1]);
    closeTo(snapAt(scene, "Delta 1 zone on Infeed · start, right").mcs, [1200, -300, 800]);
    expect(scene.warnings).toEqual([]);
  });

  it("runs the conveying direction axis from the conveyor's shifted origin along its X axis", () => {
    const shifted = conveyorConfig({ originShift: { x: 500, y: -20, z: 0 } });
    const scene = buildScene(config(shifted), [], 0);

    // In the belt's frame, metres: X along the belt, Y across it.
    expect(scene.conveyors[0]!.axis).toEqual({ originX: 0.5, originY: -0.02 });
  });

  it("draws a conveyor without a body only by its axis: no belt edges to snap to, its zones stay", () => {
    const bare = conveyorConfig({ body: false });
    const scene = buildScene(config(bare, deltaConfig({ zones: [pickZone()] })), [], 0);

    expect(scene.conveyors[0]!.body).toBe(false);
    const labels = scene.snapPoints.map((p) => p.label).filter((l) => l.startsWith("Infeed"));
    expect(labels).toEqual(["Infeed · origin", "Infeed · end centre"]);
    expect(scene.zones).toHaveLength(1);
  });

  it("draws a zone reaching past a belt end as reported, with a warning in belt coordinates", () => {
    const shifted = conveyorConfig({ originShift: { x: 500, y: 0, z: 0 } });
    const zone = pickZone({ start: 2000, end: 2600, ccsOffset: 2200 });
    const scene = buildScene(config(shifted, deltaConfig({ zones: [zone] })), [], 0);

    expect(scene.zones[0]!.length).toBeCloseTo(0.6);
    closeTo(snapAt(scene, "Delta 1 zone on Infeed · end, left").mcs, [3100, 200, 800]);
    expect(scene.warnings).toEqual([
      "Delta 1: zone on Infeed (2000 to 2600 mm) reaches past the belt (-500 to 2500 mm)",
    ]);
  });

  it("shows a component's origin and local measuring coordinates at its shifted origin, the geometry stays", () => {
    const shifted = conveyorConfig({ originShift: { x: 500, y: -20, z: 0 } });
    const robot = deltaConfig({ originShift: { x: 0, y: 0, z: -700 } });
    const scene = buildScene(config(shifted, robot), [], 0);

    const [beltOrigin, robotOrigin] = scene.origins;
    closeTo(beltOrigin!.transform.position, [0.5, 0.8, 0.02]);
    closeTo(robotOrigin!.transform.position, [1.5, 1.1, 0]);
    closeTo(snapAt(scene, "Infeed · origin").mcs, [500, -20, 800]);
    closeTo(snapAt(scene, "Infeed · end centre").local.point, [2500, 20, 0]);
    closeTo(snapAt(scene, "Delta 1 · base").local.point, [0, 0, 700]);
    // Geometry and the working area stay at the pose.
    closeTo(scene.conveyors[0]!.transform.position, [0, 0.8, 0]);
    closeTo(scene.deltas[0]!.base.position, [1.5, 1.8, 0]);
    closeTo(scene.workingAreas[0]!.transform.position, [1.5, 1.8, 0]);
  });
});

function visionConfig(overrides: Partial<VisionConfig> = {}): VisionConfig {
  return {
    type: "vision",
    id: 60,
    sourceId: "plc1",
    name: "Vision 1",
    // Lens 800 mm above the belt surface (z 800), looking down.
    pose: { x: 1000, y: 0, z: 1600, rx: 0, ry: 0, rz: 0 },
    zones: [{ conveyorId: 1, start: 800, end: 1200, allocationOffset: 0, ccsOffset: 1000, startY: 0, endY: 0 }],
    bodies: [
      { shape: "box", role: "sensor", pose: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }, length: 120, width: 80, height: 150, topLength: 0, topWidth: 0 },
      {
        shape: "frustum",
        role: "fieldOfView",
        pose: { x: 0, y: 0, z: -800, rx: 0, ry: 0, rz: 0 },
        length: 400,
        width: 300,
        height: 800,
        topLength: 20,
        topWidth: 16,
      },
    ],
    originShift: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

describe("scene model: detectors drawn from their bodies", () => {
  it("draws each body at its pose in the component's frame, with its shape, role and size", () => {
    const scene = buildScene(config(conveyorConfig(), visionConfig({ pose: { x: 1000, y: 0, z: 1600, rx: 0, ry: 0, rz: 90 } })), [], 0);
    expect(scene.bodies).toHaveLength(2);
    const [housing, field] = scene.bodies;
    expect(housing).toMatchObject({ componentId: 60, shape: "box", role: "sensor", active: false, faulted: false });
    closeTo(housing!.transform.position, [1, 1.6, 0]);
    closeTo([housing!.size.length, housing!.size.width, housing!.size.height], [0.12, 0.08, 0.15]);
    expect(field).toMatchObject({ shape: "frustum", role: "fieldOfView" });
    // Its bottom face lies on the belt surface.
    closeTo(field!.transform.position, [1, 0.8, 0]);
    closeTo([field!.top.length, field!.top.width], [0.02, 0.016]);
    // Turned with the component: its local X along MCS Y.
    closeTo(rotate(field!.transform.quaternion, [1, 0, 0]), [0, 0, -1]);
  });

  it("lights the bodies the state reports active and draws a faulted detector's bodies red with its label above them", () => {
    const scene = buildScene(
      config(conveyorConfig(), visionConfig()),
      [snapshot(0, [{ type: "vision", id: 60, timestamp: "0", bodies: [{ active: false }, { active: true }], fault: { message: "No image" } }])],
      0,
    );
    expect(scene.bodies.map((b) => [b.active, b.faulted])).toEqual([
      [false, true],
      [true, true],
    ]);
    expect(scene.faults).toEqual([{ componentId: 60, messages: ["No image"], limitViolations: [] }]);
    // Above the highest body: the housing's top at 1750 mm.
    expect(scene.faultLabels[0]!.position[1]).toBeGreaterThan(1.75);
  });

  it("draws a detector's zones like any other and a zone of length 0 as a line across the belt", () => {
    const sensor: SensorConfig = {
      ...visionConfig(),
      type: "sensor",
      id: 61,
      name: "Sensor 1",
      zones: [{ conveyorId: 1, start: 500, end: 500, allocationOffset: 0, ccsOffset: 500, startY: 0, endY: 0 }],
      bodies: [],
    };
    const scene = buildScene(config(conveyorConfig(), visionConfig(), sensor), [], 0);
    expect(scene.zones.map((z) => [z.componentId, z.length])).toEqual([
      [60, 0.4],
      [61, 0],
    ]);
    closeTo(scene.zones[1]!.transform.position, [0.5, 0.8, 0]);
    expect(scene.warnings).toEqual([]);
  });

  it("offers the origin and each body's bottom centre as snap points, the overlays' on the zones layer", () => {
    const scene = buildScene(config(conveyorConfig(), visionConfig()), [], 0);
    const points = scene.snapPoints.filter((p) => p.local.componentId === 60);
    expect(points.map((p) => [p.label, p.layer, p.mcs])).toEqual([
      ["Vision 1 · origin", "structure", [1000, 0, 1600]],
      ["Vision 1 · body 1 (sensor)", "structure", [1000, 0, 1600]],
      ["Vision 1 · body 2 (field of view)", "zones", [1000, 0, 800]],
    ]);
  });

  it("leaves out the bodies of a hidden detector", () => {
    const scene = buildScene(config(conveyorConfig(), visionConfig()), [], 0, new Set([60]));
    expect(scene.bodies).toEqual([]);
    expect(scene.zones).toEqual([]);
  });
});

describe("scene model: stations drawn from their bodies", () => {
  /** A reject unit beside the belt: a housing and the pusher plate at the belt edge, its zone a line across the belt. */
  const rejectUnit: StationConfig = {
    type: "station",
    id: 70,
    sourceId: "plc1",
    name: "Reject unit",
    pose: { x: 2400, y: -230, z: 0, rx: 0, ry: 0, rz: 0 },
    zones: [{ conveyorId: 1, start: 2400, end: 2400, allocationOffset: 0, ccsOffset: 2400, startY: 0, endY: 0 }],
    bodies: [
      { shape: "box", role: "structure", pose: { x: 0, y: -70, z: 0, rx: 0, ry: 0, rz: 0 }, length: 160, width: 140, height: 920, topLength: 0, topWidth: 0 },
      { shape: "box", role: "structure", pose: { x: 0, y: 15, z: 810, rx: 0, ry: 0, rz: 0 }, length: 120, width: 30, height: 50, topLength: 0, topWidth: 0 },
    ],
    originShift: { x: 0, y: 0, z: 0 },
  };

  it("draws its bodies, lights the pusher while it works, and draws its zone and snap points like a detector's", () => {
    const scene = buildScene(
      config(conveyorConfig(), rejectUnit),
      [snapshot(0, [{ type: "station", id: 70, timestamp: "0", bodies: [{ active: false }, { active: true }], fault: null }])],
      0,
    );
    expect(scene.bodies.map((b) => [b.componentId, b.role, b.active])).toEqual([
      [70, "structure", false],
      [70, "structure", true],
    ]);
    closeTo(scene.bodies[1]!.transform.position, [2.4, 0.81, 0.215]);
    expect(scene.zones.map((z) => [z.componentId, z.length])).toEqual([[70, 0]]);
    expect(scene.snapPoints.filter((p) => p.local.componentId === 70).map((p) => p.label)).toEqual([
      "Reject unit · origin",
      "Reject unit · body 1 (structure)",
      "Reject unit · body 2 (structure)",
    ]);
  });

  it("carries a fault with its label above its highest body", () => {
    const scene = buildScene(
      config(conveyorConfig(), rejectUnit),
      [snapshot(0, [{ type: "station", id: 70, timestamp: "0", bodies: [], fault: { message: "Pusher not in home position" } }])],
      0,
    );
    expect(scene.faults).toEqual([{ componentId: 70, messages: ["Pusher not in home position"], limitViolations: [] }]);
    expect(scene.bodies.every((b) => b.faulted)).toBe(true);
    // Above the housing's top at 920 mm.
    expect(scene.faultLabels[0]!.position[1]).toBeGreaterThan(0.92);
  });
});

describe("scene model: TCP limit areas", () => {
  const snap = (scene: ReturnType<typeof buildScene>, label: string) => {
    const point = scene.snapPoints.find((p) => p.label === label);
    if (!point) throw new Error(`no snap point "${label}" in: ${scene.snapPoints.map((p) => p.label).join(", ")}`);
    return point;
  };
  const tcpArea = { xMin: -50, xMax: 150, yMin: -60, yMax: 60, zMin: -200, zMax: 10 };

  it("draws a Delta's TCP limit area around its TCP, along the axes of its base frame, with moving corners", () => {
    const robot = deltaConfig({ pose: { x: 1500, y: 0, z: 1800, rx: 0, ry: 0, rz: 90 }, tcpLimitArea: tcpArea });
    // TCP at MCS (1600, 100, 1100): (100, −100, −700) in the base frame turned by 90°.
    const tcp = { x: 1600, y: 100, z: 1100 };
    const scene = buildScene(config(robot), [snapshot(0, [deltaState(tcp)])], 0);

    expect(scene.tcpLimitAreas).toHaveLength(1);
    const [area] = scene.tcpLimitAreas;
    expect(area).toMatchObject({ key: "20:0", robotId: 20, moverId: 0, violated: false });
    // Centre (150, −100, −795) in the base frame: MCS (1600, 150, 1005).
    closeTo(rendererToMcs(area!.transform.position), [1600, 150, 1005], 4);
    closeTo(area!.size, [0.2, 0.12, 0.21]);
    const corner = snap(scene, "Delta 1 TCP limit area · bottom, Y min, X max");
    closeTo(corner.mcs, [1660, 250, 900], 4);
    expect(corner).toMatchObject({ layer: "limitAreas", moving: true });
  });

  it("draws one TCP limit area per XTS gantry mover, around its gripper flange", () => {
    const mover2: GantryMover = { ...mover1, id: 2, position: 900 };
    const scene = buildScene(config(gantryConfig({ tcpLimitArea: tcpArea })), [snapshot(0, [gantryState(-100, [mover1, mover2])])], 0);

    expect(scene.tcpLimitAreas.map((a) => [a.key, a.moverId])).toEqual([
      ["30:1", 1],
      ["30:2", 2],
    ]);
    // Mover 1 flange at (230, 250, −500) in the gantry frame, box centre (280, 250, −595): turned by 90° about Z.
    closeTo(rendererToMcs(scene.tcpLimitAreas[0]!.transform.position), [2750, -220, 905], 4);
    expect(snap(scene, "IDH mover 2 TCP limit area · top, Y max, X min").moving).toBe(true);
  });

  it("centres a TCP limit area on the drawn gripper flange also where the mover runs through a curve module", () => {
    const curved = gantryConfig({
      modules: [straight(250), { kind: "curveLeft", length: 250 }, straight(1000)],
      tcpLimitArea: { xMin: -10, xMax: 10, yMin: -10, yMax: 10, zMin: -10, zMax: 10 },
    });
    const inCurve: GantryMover = { ...mover1, position: 400 };
    const scene = buildScene(config(curved), [snapshot(0, [gantryState(-100, [inCurve])])], 0);
    closeTo(scene.tcpLimitAreas[0]!.transform.position, scene.gantries[0]!.movers[0]!.tip.position);
  });

  it("draws a Cartesian robot's TCP limit area around its flange, also without a Y or a Z axis", () => {
    const around = { xMin: -10, xMax: 10, yMin: -10, yMax: 10, zMin: -10, zMax: 10 };
    const centre = (axes: CartesianConfig["axes"]) => {
      const robot = cartesianConfig({ axes, tcpLimitArea: around });
      const scene = buildScene(config(robot), [snapshot(0, [cartesianState()])], 0);
      return rendererToMcs(scene.tcpLimitAreas[0]!.transform.position);
    };
    // Flange at (600, 250, −400) in the robot frame at MCS (6000, 0, 2000).
    closeTo(centre("xyz"), CARTESIAN_FLANGE, 4);
    // Without a Y axis Y is 0; without a Z axis the flange stays at zMin = −600.
    closeTo(centre("xz"), [6600, 0, 1600], 4);
    closeTo(centre("xy"), [6600, 250, 1400], 4);
  });

  it("gives a TCP limit area's corners as snap points only for measure mode, since they move every frame", () => {
    const robot = deltaConfig({ tcpLimitArea: tcpArea });
    const snapshots = [snapshot(0, [deltaState({ x: 1500, y: 0, z: 1000 })])];
    const corners = (measureSnapPoints: boolean) =>
      buildScene(config(robot), snapshots, 0, new Set(), { measureSnapPoints }).snapPoints.filter((p) =>
        p.label.startsWith("Delta 1 TCP limit area"),
      );
    expect(corners(true)).toHaveLength(8);
    expect(corners(false)).toEqual([]);
  });

  it("has no TCP limit area without one in the config or before the first state", () => {
    expect(buildScene(config(deltaConfig()), [snapshot(0, [deltaState({ x: 1500, y: 0, z: 1000 })])], 0).tcpLimitAreas).toEqual([]);
    expect(buildScene(config(deltaConfig({ tcpLimitArea: tcpArea })), [], 0).tcpLimitAreas).toEqual([]);
  });
});

describe("scene model: limit violations", () => {
  const tcpArea = { xMin: -50, xMax: 150, yMin: -60, yMax: 60, zMin: -200, zMax: 10 };
  /** Delta 1 with its TCP at MCS (1500, 0, 1100): its TCP limit area spans X 1450..1650, Y −60..60, Z 900..1110. */
  const delta = (overrides: Partial<DeltaConfig> = {}) => deltaConfig({ tcpLimitArea: tcpArea, ...overrides });
  const deltaAt = snapshot(0, [deltaState({ x: 1500, y: 0, z: 1100 })]);
  /** A Cartesian robot at (1000, 0, 2000) whose limit area starts at MCS X `fromX`. */
  const neighbour = (fromX: number) =>
    cartesianConfig({
      pose: { x: 1000, y: 0, z: 2000, rx: 0, ry: 0, rz: 0 },
      limitArea: { xMin: fromX - 1000, xMax: 1000, yMin: -500, yMax: 500, zMin: -1500, zMax: -800 },
    });
  const OVERLAP = "Delta 1 TCP limit area overlaps the limit area of Cartesian";

  it("lights a TCP limit area and another robot's limit area it overlaps, lists it under both and labels it", () => {
    const scene = buildScene(config(delta(), neighbour(1600)), [deltaAt], 0);

    expect(scene.tcpLimitAreas.map((a) => a.violated)).toEqual([true]);
    expect(scene.limitAreas.map((a) => [a.robotId, a.violated])).toEqual([[50, true]]);
    expect(scene.faults).toEqual([
      { componentId: 20, messages: [], limitViolations: [OVERLAP] },
      { componentId: 50, messages: [], limitViolations: [OVERLAP] },
    ]);
    expect(scene.faultLabels).toHaveLength(1);
    expect(scene.faultLabels[0]).toMatchObject({ componentId: 20, part: null, message: OVERLAP, limit: true });
    // 100 mm above the top centre of the TCP limit area, MCS (1550, 0, 1110).
    closeTo(scene.faultLabels[0]!.position, [1.55, 1.21, 0]);
  });

  it("does not count boxes that only touch", () => {
    const scene = buildScene(config(delta(), neighbour(1650)), [deltaAt], 0);
    expect(scene.tcpLimitAreas.map((a) => a.violated)).toEqual([false]);
    expect(scene.limitAreas.map((a) => a.violated)).toEqual([false]);
    expect(scene.faults).toEqual([]);
  });

  it("checks boxes turned against each other by their real outline, not by an axis-aligned hull", () => {
    // Turned by 45° about Z at MCS X = x: its near edge crosses Y = ±60 at X = x ∓ 60, its hull reaches back to x − 354.
    const turned = (x: number) =>
      cartesianConfig({
        pose: { x, y: 0, z: 2000, rx: 0, ry: 0, rz: 45 },
        limitArea: { xMin: 0, xMax: 500, yMin: -500, yMax: 500, zMin: -1500, zMax: -800 },
      });
    // The TCP limit area ends at X = 1650: the edge reaches it at 1700 − 60, not at 1720 − 60.
    expect(buildScene(config(delta(), turned(1700)), [deltaAt], 0).tcpLimitAreas[0]!.violated).toBe(true);
    expect(buildScene(config(delta(), turned(1720)), [deltaAt], 0).tcpLimitAreas[0]!.violated).toBe(false);
  });

  it("lights a TCP limit area and its robot's limit area when it leaves it", () => {
    const leaving = delta({ limitArea: { xMin: -500, xMax: 500, yMin: -500, yMax: 500, zMin: -1400, zMax: -750 } });
    const scene = buildScene(config(leaving), [deltaAt], 0);
    expect(scene.tcpLimitAreas[0]!.violated).toBe(true);
    expect(scene.limitAreas[0]!.violated).toBe(true);
    expect(scene.faults).toEqual([
      { componentId: 20, messages: [], limitViolations: ["Delta 1 TCP limit area leaves the limit area of Delta 1"] },
    ]);

    const inside = delta({ limitArea: { xMin: -500, xMax: 500, yMin: -500, yMax: 500, zMin: -1400, zMax: 10 - 700 } });
    expect(buildScene(config(inside), [deltaAt], 0).faults).toEqual([]);
  });

  it("finds two movers of the same gantry whose TCP limit areas overlap", () => {
    const close: GantryMover = { ...mover1, id: 2, position: 300 };
    const far: GantryMover = { ...mover1, id: 3, position: 1500 };
    const gantry = gantryConfig({ tcpLimitArea: tcpArea });
    const scene = buildScene(config(gantry), [snapshot(0, [gantryState(-100, [mover1, close, far])])], 0);
    expect(scene.tcpLimitAreas.map((a) => [a.moverId, a.violated])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
    expect(scene.faults).toEqual([
      { componentId: 30, messages: [], limitViolations: ["IDH mover 1 TCP limit area overlaps the TCP limit area of IDH mover 2"] },
    ]);
  });

  it("still lists a violation of a hidden robot, without drawing its boxes or label", () => {
    const scene = buildScene(config(delta(), neighbour(1600)), [deltaAt], 0, new Set([20]));
    expect(scene.tcpLimitAreas).toEqual([]);
    expect(scene.faultLabels).toEqual([]);
    expect(scene.faults.map((f) => f.limitViolations)).toEqual([[OVERLAP], [OVERLAP]]);
  });

  it("checks nothing while the source is offline, but still draws the TCP limit areas", () => {
    const source = (online: boolean) => ({
      sourceId: "plc1",
      config: config(delta(), neighbour(1600)),
      snapshots: [deltaAt],
      renderTime: 0,
      online,
    });
    const offline = buildMachineScene([source(false)], new Set());
    expect(offline.faults).toEqual([]);
    expect(offline.sources[0]!.scene.tcpLimitAreas.map((a) => a.violated)).toEqual([false]);
    expect(buildMachineScene([source(true)], new Set()).faults.map((f) => f.componentId)).toEqual([20, 50]);
  });
});
