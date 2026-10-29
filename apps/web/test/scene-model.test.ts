import { describe, expect, it } from "vitest";
import type { ConfigMessage, ConveyorConfig, DeltaConfig, PlanarPose, Product, StateMessage } from "@rpp/protocol";
import { buildScene, rendererToMcs, type Vec3 } from "../src/scene/scene-model";

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
    productTypes: [{ id: 1, length: 100, width: 80, height: 40 }],
    ...overrides,
  };
}

function config(...components: ConfigMessage["components"]): ConfigMessage {
  return { kind: "config", protocolVersion: 1, configVersion: 1, components, errors: [] };
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
    latchPose: { x: 0, y: 0, z: 800, rz: 0 },
    latchEncoder: 0,
    state: "detected",
    robotId: 0,
    productType: 1,
    ...overrides,
  };
}

function snapshot(tRel: number, components: StateMessage["components"]): StateMessage {
  return { kind: "state", configVersion: 1, timestamp: String(tRel * 1e6), tRel, components };
}

function conveyorState(encoder: number, products: Product[], id = 1): StateMessage["components"][number] {
  return { type: "conveyor", id, timestamp: "0", encoder, products };
}

describe("scene model: product tracking", () => {
  it("moves a product from its latch pose along the conveying direction by the encoder travel", () => {
    const belt = conveyorConfig({ pose: { x: 1000, y: 0, z: 800, rx: 0, ry: 0, rz: 90 } });
    const p = product({ latchPose: { x: 1000, y: 100, z: 800, rz: 15 }, latchEncoder: 40 });

    const scene = buildScene(config(belt), [snapshot(0, [conveyorState(540, [p])])], 0);

    const [shown] = scene.products;
    expect(shown).toMatchObject({ productId: 7, conveyorId: 1, display: "normal", state: "detected" });
    // Bottom centre at MCS (1000, 600, 800); the box centre sits half its height (40 mm) above.
    closeTo(shown!.transform.position, [1, 0.82, -0.6]);
    closeTo(rotate(shown!.transform.quaternion, [1, 0, 0]), [Math.cos((15 * Math.PI) / 180), 0, -Math.sin((15 * Math.PI) / 180)]);
    expect(shown!.size).toEqual({ length: 0.1, width: 0.08, height: 0.04 });
  });
});

describe("scene model: interpolation", () => {
  const belt = conveyorConfig();
  const p = product({ latchPose: { x: 100, y: 0, z: 800, rz: 0 } });
  const xAt = (snapshots: StateMessage[], t: number) => buildScene(config(belt), snapshots, t).products[0]!.transform.position[0];

  it("interpolates the encoder linearly between the surrounding snapshots by tRel", () => {
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
    hasRotationAxis: false,
    workArea: { radius: 600, zMin: -1100, zMax: -600, coneHeight: 0, coneBottomRadius: 0 },
    windows: [],
    ...overrides,
  };
}

/** sqrt(800² − (200 + 350 − 50)²): TCP depth below the base at which all upper arms are horizontal. */
const HORIZONTAL_DEPTH = 624.4997998398398;

function deltaState(tcp: PlanarPose, setpoint = tcp, id = 20): StateMessage["components"][number] {
  return { type: "delta", id, timestamp: "0", actualTcp: tcp, setpointTcp: setpoint };
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(...a.map((v, i) => v - b[i]!));

describe("scene model: delta follows the TCP", () => {
  it("draws all upper arms horizontal when the TCP is straight below the base at the closing depth", () => {
    const tcp = { x: 1500, y: 0, z: 1800 - HORIZONTAL_DEPTH, rz: 0 };
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
    const tcp = { x: 1650, y: 80, z: 1050, rz: 0 };
    const [d] = buildScene(config(cfg), [snapshot(0, [deltaState(tcp)])], 0).deltas;

    expect(d!.reachable).toBe(true);
    closeTo(d!.effector!.position, [1.65, 1.05, -0.08]);
    for (let i = 0; i < 3; i++) {
      expect(dist(d!.shoulders[i]!, d!.elbows[i]!)).toBeCloseTo(0.35, 6);
      expect(dist(d!.elbows[i]!, d!.effectorJoints[i]!)).toBeCloseTo(0.8, 6);
      expect(dist(d!.effectorJoints[i]!, d!.effector!.position)).toBeCloseTo(0.05, 6);
    }
  });

  it("marks a TCP the arms cannot reach as unreachable but still shows the effector at the TCP", () => {
    const [d] = buildScene(config(deltaConfig()), [snapshot(0, [deltaState({ x: 1500, y: 0, z: 0, rz: 0 })])], 0).deltas;
    expect(d!.reachable).toBe(false);
    expect(d!.elbows).toEqual([]);
    closeTo(d!.effector!.position, [1.5, 0, 0]);
  });

  it("shows the setpoint TCP reported by the PLC as a separate marker", () => {
    const scene = buildScene(
      config(deltaConfig()),
      [snapshot(0, [deltaState({ x: 1500, y: 100, z: 1000, rz: 0 }, { x: 1510, y: 100, z: 1000, rz: 0 })])],
      0,
    );
    closeTo(scene.deltas[0]!.actualTcp!, [1.5, 1, -0.1]);
    closeTo(scene.deltas[0]!.setpointTcp!, [1.51, 1, -0.1]);
  });

  it("interpolates the TCP between snapshots and the arms follow", () => {
    const snapshots = [
      snapshot(0, [deltaState({ x: 1500, y: 0, z: 1000, rz: 0 })]),
      snapshot(20, [deltaState({ x: 1600, y: 0, z: 1000, rz: 0 })]),
    ];
    const d = buildScene(config(deltaConfig()), snapshots, 10).deltas[0]!;
    closeTo(d.effector!.position, [1.55, 1, 0]);
    closeTo(d.actualTcp!, [1.55, 1, 0]);
  });

  it("rotates the effector by the TCP's rz, interpolating across the ±180° wrap the short way", () => {
    const snapshots = [
      snapshot(0, [deltaState({ x: 1500, y: 0, z: 1000, rz: 179 })]),
      snapshot(20, [deltaState({ x: 1500, y: 0, z: 1000, rz: -179 })]),
    ];
    const d = buildScene(config(deltaConfig({ hasRotationAxis: true })), snapshots, 10).deltas[0]!;
    // Halfway between 179° and −179° is 180°: the effector's local +X points along MCS −X.
    closeTo(rotate(d.effector!.quaternion, [1, 0, 0]), [-1, 0, 0]);
  });
});

describe("scene model: product lifecycle", () => {
  const belt = conveyorConfig({ length: 3000 });
  const robot = deltaConfig();
  const tcp = { x: 1500, y: 0, z: 1000, rz: 0 };
  const show = (p: Product, encoder = 0) =>
    buildScene(config(belt, robot), [snapshot(0, [conveyorState(encoder, [p]), deltaState(tcp)])], 0).products;

  it("hangs a picked product below its robot's TCP and leaves a placeholder travelling on the belt", () => {
    const shown = show(product({ state: "picked", robotId: 20, latchPose: { x: 1000, y: 0, z: 800, rz: 0 } }), 200);

    expect(shown.map((p) => p.display).sort()).toEqual(["atTcp", "placeholder"]);
    // The product's top touches the TCP: centre 20 mm (half of 40 mm) below.
    closeTo(shown.find((p) => p.display === "atTcp")!.transform.position, [1.5, 0.98, 0]);
    closeTo(shown.find((p) => p.display === "placeholder")!.transform.position, [1.2, 0.82, 0]);
    expect(new Set(shown.map((p) => p.key)).size).toBe(2);
  });

  it("removes the placeholder once it passes the belt end, without flagging it as missed", () => {
    // Latched at belt x = 1000, travelled 2100 mm -> belt x = 3100 beyond the 3000 mm belt.
    const shown = show(product({ state: "picked", robotId: 20, latchPose: { x: 1000, y: 0, z: 800, rz: 0 } }), 2100);
    expect(shown.map((p) => p.display)).toEqual(["atTcp"]);
  });

  it("drops a placed product from the TCP but keeps its placeholder on the belt", () => {
    const shown = show(product({ state: "placed", robotId: 20, latchPose: { x: 1000, y: 0, z: 800, rz: 0 } }), 200);
    expect(shown.map((p) => p.display)).toEqual(["placeholder"]);
  });

  it("flags an unpicked product that ran past the belt end as missed and holds it at the belt end", () => {
    for (const state of ["detected", "assigned"] as const) {
      const shown = show(product({ state, latchPose: { x: 2900, y: 0, z: 800, rz: 0 } }), 500);
      expect(shown).toHaveLength(1);
      expect(shown[0]!.display).toBe("missed");
      // Held with its front edge at the belt end: centre half a length (50 mm) before 3000 mm.
      closeTo(shown[0]!.transform.position, [2.95, 0.82, 0]);
    }
  });

  it("hides a rejected product beyond the belt end instead of flagging it as missed", () => {
    const shown = show(product({ state: "rejected", latchPose: { x: 2900, y: 0, z: 800, rz: 0 } }), 500);
    expect(shown).toEqual([]);
  });

  it("shows only the register entries present in the snapshot", () => {
    expect(show(product(), 0)).toHaveLength(1);
    const scene = buildScene(config(belt, robot), [snapshot(0, [conveyorState(0, [])])], 0);
    expect(scene.products).toEqual([]);
  });
});

describe("scene model: work areas and windows", () => {
  it("resolves a robot's windows onto the referenced conveyor in belt coordinates", () => {
    const belt = conveyorConfig({ pose: { x: 1000, y: 0, z: 800, rx: 0, ry: 0, rz: 90 }, width: 400 });
    const robot = deltaConfig({
      windows: [
        { conveyorId: 1, start: 1200, end: 1800, kind: "pick" },
        { conveyorId: 99, start: 0, end: 100, kind: "place" },
      ],
    });
    const scene = buildScene(config(belt, robot), [], 0);

    expect(scene.windows).toHaveLength(1);
    const [w] = scene.windows;
    expect(w).toMatchObject({ robotId: 20, conveyorId: 1, kind: "pick" });
    // Centre at belt x = 1500 along the belt's +X, which points along MCS +Y.
    closeTo(w!.transform.position, [1, 0.8, -1.5]);
    closeTo(rotate(w!.transform.quaternion, [1, 0, 0]), [0, 0, -1]);
    expect(w!.length).toBeCloseTo(0.6);
    expect(w!.width).toBeCloseTo(0.4);
    expect(scene.warnings).toEqual([expect.stringMatching(/Delta 1.*conveyor 99/)]);
  });

  it("places the configured work area in the robot's frame in metres", () => {
    const robot = deltaConfig({
      workArea: { radius: 600, zMin: -1100, zMax: -600, coneHeight: 200, coneBottomRadius: 400 },
    });
    const [area] = buildScene(config(robot), [], 0).workAreas;

    expect(area).toMatchObject({ robotId: 20 });
    closeTo(area!.transform.position, [1.5, 1.8, 0]);
    closeTo([area!.radius, area!.zMin, area!.zMax, area!.coneHeight, area!.coneBottomRadius], [0.6, -1.1, -0.6, 0.2, 0.4]);
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
