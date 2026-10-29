import type { Vec3 } from "@rpp/protocol";
import { InMemoryPlc } from "./in-memory-plc";
import { MAX_PRODUCTS, conveyor, defineMachine, delta, emptyProduct } from "./plc-builders";
import {
  E_VisuProductState,
  E_VisuWindowKind,
  type ST_VisuConveyor,
  type ST_VisuDelta,
  type ST_VisuProduct,
} from "./plc-contract";

/**
 * Sample machine behind the same contract as a real PLC: an infeed and an outfeed conveyor with
 * product tracking and one Delta picking from the infeed and placing onto the outfeed.
 * It is an in-memory PLC whose values change on every `step`, so it runs through real discovery.
 */
export interface Simulator {
  plc: InMemoryPlc;
  /** Advance the simulated machine by `dtMs` milliseconds. */
  step(dtMs: number): void;
}

const INFEED = { id: 1, path: "MAIN.stInfeed", x: 0, y: 0, z: 800, length: 3000, width: 400, speed: 150 };
const OUTFEED = { id: 2, path: "MAIN.stOutfeed", x: 0, y: 900, z: 800, length: 3000, width: 400, speed: 100 };
const ROBOT = { id: 10, path: "MAIN.stDelta1", x: 1500, y: 450, z: 1900 };
const GEOMETRY = { baseRadius: 200, effectorRadius: 50, upperArmLength: 400, lowerArmLength: 950 };
const PRODUCT = { type: 1, length: 120, width: 80, height: 40 };
const PICK_WINDOW = { start: 1100, end: 1900 };
const PLACE_X = 1500;
const SPAWN_INTERVAL_MS = 700;
const TCP_SPEED = 2500; // mm/s
const HOVER = 120; // mm above the product top
/** Products are removed from the register this far beyond the belt end, so "missed" stays visible briefly. */
const REMOVE_BEYOND_END = 300;

type RobotPhase = "idle" | "approach" | "descend" | "lift" | "transfer" | "lower" | "release";

interface TrackedProduct extends ST_VisuProduct {}

/** Small deterministic PRNG so tests are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSimulator(options: { seed?: number } = {}): Simulator {
  const random = mulberry32(options.seed ?? Date.now());
  const plc = new InMemoryPlc();
  defineMachine(plc, [
    {
      id: INFEED.id,
      name: "Infeed",
      path: INFEED.path,
      kind: "conveyor",
      value: conveyor({
        pose: { fX: INFEED.x, fY: INFEED.y, fZ: INFEED.z },
        length: INFEED.length,
        width: INFEED.width,
        productTypes: [{ nId: PRODUCT.type, fLength: PRODUCT.length, fWidth: PRODUCT.width, fHeight: PRODUCT.height }],
      }),
    },
    {
      id: OUTFEED.id,
      name: "Outfeed",
      path: OUTFEED.path,
      kind: "conveyor",
      value: conveyor({
        pose: { fX: OUTFEED.x, fY: OUTFEED.y, fZ: OUTFEED.z },
        length: OUTFEED.length,
        width: OUTFEED.width,
        productTypes: [{ nId: PRODUCT.type, fLength: PRODUCT.length, fWidth: PRODUCT.width, fHeight: PRODUCT.height }],
      }),
    },
    {
      id: ROBOT.id,
      name: "Delta 1",
      path: ROBOT.path,
      kind: "delta",
      value: delta({
        pose: { fX: ROBOT.x, fY: ROBOT.y, fZ: ROBOT.z },
        ...GEOMETRY,
        hasRotationAxis: true,
        windows: [
          { nConveyorId: INFEED.id, fStart: PICK_WINDOW.start, fEnd: PICK_WINDOW.end, eKind: E_VisuWindowKind.PICK },
          { nConveyorId: OUTFEED.id, fStart: PLACE_X - 300, fEnd: PLACE_X + 300, eKind: E_VisuWindowKind.PLACE },
        ],
      }),
    },
  ]);
  const infeed = plc.get<ST_VisuConveyor>(INFEED.path);
  const outfeed = plc.get<ST_VisuConveyor>(OUTFEED.path);
  const robot = plc.get<ST_VisuDelta>(ROBOT.path);
  robot.stConfig.stWorkArea = { fRadius: 700, fZMin: -1300, fZMax: -700, fConeHeight: 200, fConeBottomRadius: 400 };

  // DC time: ns since 2000-01-01.
  let now = BigInt(Date.UTC(2026, 0, 1) - Date.UTC(2000, 0, 1)) * 1_000_000n;
  let nextId = 1;
  let sinceSpawn = SPAWN_INTERVAL_MS;
  const infeedProducts: TrackedProduct[] = [];
  const outfeedProducts: TrackedProduct[] = [];

  const home: Vec3 = [ROBOT.x, ROBOT.y, ROBOT.z - 900];
  let tcp: Vec3 = [...home];
  let tcpRz = 0;
  let phase: RobotPhase = "idle";
  let target: TrackedProduct | undefined;

  /** Current MCS position of a tracked product's bottom centre. */
  function productPosition(p: TrackedProduct, encoder: number): Vec3 {
    return [p.stLatchPose.fX + (encoder - p.fLatchEncoder), p.stLatchPose.fY, p.stLatchPose.fZ];
  }

  function moveToward(goal: Vec3, dtS: number): boolean {
    const d: Vec3 = [goal[0] - tcp[0], goal[1] - tcp[1], goal[2] - tcp[2]];
    const dist = Math.hypot(...d);
    const stepLen = TCP_SPEED * dtS;
    if (dist <= stepLen) {
      tcp = [...goal];
      return true;
    }
    tcp = [tcp[0] + (d[0] / dist) * stepLen, tcp[1] + (d[1] / dist) * stepLen, tcp[2] + (d[2] / dist) * stepLen];
    return false;
  }

  function stepRobot(dtS: number): void {
    const enc = infeed.stState.fEncoder;
    const top = (p: TrackedProduct): Vec3 => {
      const pos = productPosition(p, enc);
      return [pos[0], pos[1], pos[2] + PRODUCT.height];
    };
    // Lead the moving product by the belt speed so the robot meets it.
    const ahead = (p: Vec3, z: number): Vec3 => [p[0] + INFEED.speed * 0.05, p[1], z];
    switch (phase) {
      case "idle": {
        target = infeedProducts.find((p) => {
          const x = productPosition(p, enc)[0] - INFEED.x;
          return p.eState === E_VisuProductState.DETECTED && x >= PICK_WINDOW.start && x <= PICK_WINDOW.end - 300;
        });
        if (target) {
          target.eState = E_VisuProductState.ASSIGNED;
          target.nRobotId = ROBOT.id;
          phase = "approach";
        } else {
          moveToward(home, dtS);
        }
        break;
      }
      case "approach": {
        const t = top(target!);
        if (t[0] - INFEED.x > PICK_WINDOW.end) {
          // Product left the window: give up, it will be missed.
          target!.eState = E_VisuProductState.DETECTED;
          target!.nRobotId = 0;
          phase = "idle";
        } else if (moveToward(ahead(t, t[2] + HOVER), dtS)) phase = "descend";
        tcpRz += (target!.stLatchPose.fRz - tcpRz) * Math.min(1, dtS * 10);
        break;
      }
      case "descend":
        if (moveToward(ahead(top(target!), top(target!)[2]), dtS)) {
          target!.eState = E_VisuProductState.PICKED;
          phase = "lift";
        }
        break;
      case "lift":
        if (moveToward([tcp[0], tcp[1], top(target!)[2] + HOVER], dtS)) phase = "transfer";
        break;
      case "transfer": {
        const placeTop: Vec3 = [OUTFEED.x + PLACE_X, OUTFEED.y, OUTFEED.z + PRODUCT.height];
        tcpRz += (0 - tcpRz) * Math.min(1, dtS * 5);
        if (moveToward([placeTop[0], placeTop[1], placeTop[2] + HOVER], dtS)) phase = "lower";
        break;
      }
      case "lower":
        if (moveToward([tcp[0], tcp[1], OUTFEED.z + PRODUCT.height], dtS)) phase = "release";
        break;
      case "release": {
        target!.eState = E_VisuProductState.PLACED;
        outfeedProducts.push({
          ...emptyProduct(),
          nId: nextId++,
          bValid: true,
          stLatchPose: { fX: tcp[0], fY: tcp[1], fZ: OUTFEED.z, fRz: tcpRz },
          fLatchEncoder: outfeed.stState.fEncoder,
          eState: E_VisuProductState.DETECTED,
          nProductType: PRODUCT.type,
        });
        target = undefined;
        phase = "idle";
        break;
      }
    }
  }

  function writeRegister(c: ST_VisuConveyor, products: TrackedProduct[], beltX: number, length: number): void {
    // The PLC drops entries some distance beyond the belt end.
    for (let i = products.length - 1; i >= 0; i--) {
      const x = productPosition(products[i]!, c.stState.fEncoder)[0] - beltX;
      if (x > length + REMOVE_BEYOND_END && products[i] !== target) products.splice(i, 1);
    }
    const visible = products.slice(0, MAX_PRODUCTS);
    c.stState.nProductCount = visible.length;
    c.stState.aProducts = [
      ...visible.map((p) => ({ ...p, stLatchPose: { ...p.stLatchPose } })),
      ...Array.from({ length: MAX_PRODUCTS - visible.length }, emptyProduct),
    ];
    c.stState.nTimestamp = now;
  }

  function writeRobot(dtS: number): void {
    robot.stState.stActualTcp = { fX: tcp[0], fY: tcp[1], fZ: tcp[2], fRz: tcpRz };
    // Setpoint leads the actual position slightly, like a small following error.
    robot.stState.stSetpointTcp = { fX: tcp[0] + 2, fY: tcp[1], fZ: tcp[2] - 1, fRz: tcpRz };
    robot.stState.nTimestamp = now;
    void dtS;
  }

  return {
    plc,
    step(dtMs) {
      const dtS = dtMs / 1000;
      now += BigInt(Math.round(dtMs * 1_000_000));
      infeed.stState.fEncoder += INFEED.speed * dtS;
      outfeed.stState.fEncoder += OUTFEED.speed * dtS;

      sinceSpawn += dtMs;
      if (sinceSpawn >= SPAWN_INTERVAL_MS) {
        sinceSpawn = 0;
        infeedProducts.push({
          ...emptyProduct(),
          nId: nextId++,
          bValid: true,
          stLatchPose: {
            fX: INFEED.x + 100,
            fY: INFEED.y + (random() - 0.5) * 240,
            fZ: INFEED.z,
            fRz: (random() - 0.5) * 60,
          },
          fLatchEncoder: infeed.stState.fEncoder,
          eState: E_VisuProductState.DETECTED,
          nProductType: PRODUCT.type,
        });
      }

      stepRobot(dtS);
      writeRegister(infeed, infeedProducts, INFEED.x, INFEED.length);
      writeRegister(outfeed, outfeedProducts, OUTFEED.x, OUTFEED.length);
      writeRobot(dtS);
    },
  };
}
