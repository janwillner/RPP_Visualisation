import type { Vec3 } from "@rpp/protocol";
import { InMemoryPlc } from "./in-memory-plc";
import { MAX_PRODUCTS, conveyor, defineMachine, delta, emptyProduct, xtsGantry, xtsLoop } from "./plc-builders";
import {
  E_VisuProductState,
  E_VisuZoneKind,
  type ST_VisuConveyor,
  type ST_VisuDelta,
  type ST_VisuProduct,
  type ST_VisuXtsGantry,
  type ST_VisuXtsLoop,
} from "./plc-contract";

/**
 * Sample machine behind the same contract as a real PLC:
 * - a Delta picks from the infeed and places onto the outfeed;
 * - an XTS loop (Fxx) takes the products over at the end of the outfeed and puts them onto the spacing belt with
 *   a new spacing;
 * - an XTS gantry (IDH) with four movers picks them from the spacing belt in batches of four and places them onto
 *   the tray belt.
 * It is an in-memory PLC whose values change on every `step`, so it runs through real discovery.
 */
export interface Simulator {
  plc: InMemoryPlc;
  /** Advance the simulated machine by `dtMs` milliseconds. */
  step(dtMs: number): void;
}

const BELT_Z = 800;
const INFEED = { id: 1, path: "MAIN.stInfeed", x: 0, y: 0, length: 3000, speed: 150 };
const OUTFEED = { id: 2, path: "MAIN.stOutfeed", x: 0, y: 900, length: 3000, speed: 100 };
const SPACING = { id: 3, path: "MAIN.stSpacingBelt", x: 3600, y: 900, length: 3000, speed: 400 };
const TRAY = { id: 4, path: "MAIN.stTrayBelt", x: 4500, y: 500, length: 2000, speed: 80 };
const ROBOT = { id: 10, path: "MAIN.stDelta1", x: 1500, y: 450, z: 1900 };
const GEOMETRY = { baseRadius: 200, effectorRadius: 50, upperArmLength: 400, lowerArmLength: 950 };
const PRODUCT = { type: 1, length: 120, width: 80, height: 40 };
const PICK_ZONE = { start: 1100, end: 1900 };
const PLACE_X = 1500;
const SPAWN_INTERVAL_MS = 700;
const TCP_SPEED = 2500; // mm/s
const HOVER = 120; // mm above the product top
/** Products are removed from the register this far beyond the belt end, so "missed" stays visible briefly. */
const REMOVE_BEYOND_END = 300;

/** XTS loop above the outfeed's end and the spacing belt's start; tool points at the product tops. */
const LOOP = {
  id: 20,
  path: "MAIN.fbFxx.stVisu",
  x: 2200,
  straight: 2400,
  radius: 250,
  toolOffset: 120,
  movers: 12,
  moverLength: 100,
  slot: 130,
  /** Track positions: products are gripped here and handed over here (loop x 4200 = spacing belt x 600). */
  grip: 300,
  release: 600,
  place: 2000,
  deliverSpeed: 700,
  returnSpeed: 900,
};
const LOOP_PERIMETER = 2 * LOOP.straight + 2 * Math.PI * LOOP.radius;

/**
 * XTS gantry turned by −90°: its track (local +Y) runs along MCS +X above the spacing belt, its X axes (local +X)
 * reach towards MCS −Y, over the spacing belt at X = 200 and over the tray belt at X = 600.
 */
const GANTRY = {
  id: 30,
  path: "MAIN.fbIdh.stVisu",
  x: 4700,
  y: 1250,
  z: BELT_Z + PRODUCT.height + 400 + 100,
  modules: 6,
  moduleLength: 250,
  toolOffsetX: 150,
  toolOffsetZ: -400,
  moverLength: 155,
  gap: 180,
  xBelt: 200,
  xTray: 600,
  zDown: -100,
  zSpeed: 500,
  xSpeed: 1000,
  trackSpeed: 1500,
  wait: [100, 300, 500, 700],
};

type RobotPhase = "idle" | "approach" | "descend" | "lift" | "transfer" | "lower" | "release";
type LoopMode = "queue" | "track" | "deliver" | "return";
type GantryPhase = "collect" | "pickDown" | "pickUp" | "toTray" | "placeDown" | "placeUp" | "return";

interface TrackedProduct extends ST_VisuProduct {}

interface LoopMover {
  id: number;
  /** Unwrapped track position; queued movers wait just before the perimeter (≡ 0). */
  s: number;
  mode: LoopMode;
  product?: TrackedProduct;
}

interface GantryMover {
  id: number;
  position: number;
  x: number;
  c: number;
  gripper: boolean;
  product?: TrackedProduct;
}

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

/** Moves `value` towards `goal` by at most `step`. */
function approach(value: number, goal: number, step: number): number {
  return Math.abs(goal - value) <= step ? goal : value + Math.sign(goal - value) * step;
}

const productTypes = [{ nId: PRODUCT.type, fLength: PRODUCT.length, fWidth: PRODUCT.width, fHeight: PRODUCT.height }];

export function createSimulator(options: { seed?: number } = {}): Simulator {
  const random = mulberry32(options.seed ?? Date.now());
  const plc = new InMemoryPlc();
  const belt = (b: { x: number; y: number; length: number }) =>
    conveyor({ pose: { fX: b.x, fY: b.y, fZ: BELT_Z }, length: b.length, width: 400, productTypes });
  defineMachine(plc, [
    { id: INFEED.id, name: "Infeed", path: INFEED.path, kind: "conveyor", value: belt(INFEED) },
    { id: OUTFEED.id, name: "Outfeed", path: OUTFEED.path, kind: "conveyor", value: belt(OUTFEED) },
    { id: SPACING.id, name: "Spacing belt", path: SPACING.path, kind: "conveyor", value: belt(SPACING) },
    { id: TRAY.id, name: "Tray belt", path: TRAY.path, kind: "conveyor", value: belt(TRAY) },
    {
      id: ROBOT.id,
      name: "Delta 1",
      path: ROBOT.path,
      kind: "delta",
      value: delta({
        pose: { fX: ROBOT.x, fY: ROBOT.y, fZ: ROBOT.z },
        ...GEOMETRY,
        hasRotationAxis: true,
        zones: [
          { nConveyorId: INFEED.id, fStart: PICK_ZONE.start, fEnd: PICK_ZONE.end, eKind: E_VisuZoneKind.PICK },
          { nConveyorId: OUTFEED.id, fStart: PLACE_X - 300, fEnd: PLACE_X + 300, eKind: E_VisuZoneKind.PLACE },
        ],
      }),
    },
    {
      id: LOOP.id,
      name: "Fxx",
      path: LOOP.path,
      kind: "xtsLoop",
      value: xtsLoop({
        pose: { fX: LOOP.x, fY: OUTFEED.y, fZ: BELT_Z + PRODUCT.height + LOOP.toolOffset },
        straightLength: LOOP.straight,
        curveRadius: LOOP.radius,
        zones: [
          {
            nConveyorId: OUTFEED.id,
            fStart: LOOP.x - OUTFEED.x,
            fEnd: LOOP.x - OUTFEED.x + LOOP.release,
            eKind: E_VisuZoneKind.PICK,
          },
          {
            nConveyorId: SPACING.id,
            fStart: LOOP.x + LOOP.place - SPACING.x - 300,
            fEnd: LOOP.x + LOOP.place - SPACING.x + 100,
            eKind: E_VisuZoneKind.PLACE,
          },
        ],
      }),
    },
    {
      id: GANTRY.id,
      name: "IDH",
      path: GANTRY.path,
      kind: "xtsGantry",
      value: xtsGantry({
        pose: { fX: GANTRY.x, fY: GANTRY.y, fZ: GANTRY.z, fRz: -90 },
        moduleCount: GANTRY.modules,
        moduleLength: GANTRY.moduleLength,
        zones: [
          {
            nConveyorId: SPACING.id,
            fStart: GANTRY.x - SPACING.x,
            fEnd: GANTRY.x - SPACING.x + GANTRY.modules * GANTRY.moduleLength,
            eKind: E_VisuZoneKind.PICK,
          },
          { nConveyorId: TRAY.id, fStart: 200, fEnd: 1700, eKind: E_VisuZoneKind.PLACE },
        ],
      }),
    },
  ]);
  const infeed = plc.get<ST_VisuConveyor>(INFEED.path);
  const outfeed = plc.get<ST_VisuConveyor>(OUTFEED.path);
  const spacing = plc.get<ST_VisuConveyor>(SPACING.path);
  const tray = plc.get<ST_VisuConveyor>(TRAY.path);
  const robot = plc.get<ST_VisuDelta>(ROBOT.path);
  robot.stConfig.stWorkingArea = { fRadius: 700, fZMin: -1300, fZMax: -700, fConeHeight: 200, fConeBottomRadius: 400 };
  const loop = plc.get<ST_VisuXtsLoop>(LOOP.path);
  loop.stConfig.fToolOffset = LOOP.toolOffset;
  loop.stConfig.fMoverLength = LOOP.moverLength;
  const gantry = plc.get<ST_VisuXtsGantry>(GANTRY.path);
  Object.assign(gantry.stConfig, {
    fXMin: 0,
    fXMax: 700,
    fZMin: GANTRY.zDown,
    fZMax: 0,
    fToolOffsetX: GANTRY.toolOffsetX,
    fToolOffsetZ: GANTRY.toolOffsetZ,
    fMoverLength: GANTRY.moverLength,
  });

  // DC time: ns since 2000-01-01.
  let now = BigInt(Date.UTC(2026, 0, 1) - Date.UTC(2000, 0, 1)) * 1_000_000n;
  let nextId = 1;
  let sinceSpawn = SPAWN_INTERVAL_MS;
  const infeedProducts: TrackedProduct[] = [];
  const outfeedProducts: TrackedProduct[] = [];
  const spacingProducts: TrackedProduct[] = [];
  const trayProducts: TrackedProduct[] = [];

  const home: Vec3 = [ROBOT.x, ROBOT.y, ROBOT.z - 900];
  let tcp: Vec3 = [...home];
  let tcpRz = 0;
  let phase: RobotPhase = "idle";
  let target: TrackedProduct | undefined;

  // All loop movers start queued behind the start of the lower straight.
  const loopMovers: LoopMover[] = Array.from({ length: LOOP.movers }, (_, i) => ({
    id: i + 1,
    s: LOOP_PERIMETER - i * LOOP.slot,
    mode: "queue",
  }));

  let gantryPhase: GantryPhase = "collect";
  let gantryZ = 0;
  const gantryMovers: GantryMover[] = GANTRY.wait.map((position, i) => ({
    id: i + 1,
    position,
    x: GANTRY.xBelt,
    c: 0,
    gripper: false,
  }));

  /** Current MCS position of a tracked product's bottom centre on a belt along MCS +X. */
  function productPosition(p: TrackedProduct, beltPosition: number): Vec3 {
    return [p.stLatchPose.fX + (beltPosition - p.fLatchBeltPosition), p.stLatchPose.fY, p.stLatchPose.fZ];
  }

  function latch(products: TrackedProduct[], c: ST_VisuConveyor, x: number, y: number, rz: number): void {
    products.push({
      ...emptyProduct(),
      nId: nextId++,
      bValid: true,
      stLatchPose: { fX: x, fY: y, fZ: BELT_Z, fRz: rz },
      fLatchBeltPosition: c.stState.fBeltPosition,
      eState: E_VisuProductState.DETECTED,
      nProductType: PRODUCT.type,
    });
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
    const enc = infeed.stState.fBeltPosition;
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
          return p.eState === E_VisuProductState.DETECTED && x >= PICK_ZONE.start && x <= PICK_ZONE.end - 300;
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
        if (t[0] - INFEED.x > PICK_ZONE.end) {
          // Product left the zone: give up, it will be missed.
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
        const placeTop: Vec3 = [OUTFEED.x + PLACE_X, OUTFEED.y, BELT_Z + PRODUCT.height];
        tcpRz += (0 - tcpRz) * Math.min(1, dtS * 5);
        if (moveToward([placeTop[0], placeTop[1], placeTop[2] + HOVER], dtS)) phase = "lower";
        break;
      }
      case "lower":
        if (moveToward([tcp[0], tcp[1], BELT_Z + PRODUCT.height], dtS)) phase = "release";
        break;
      case "release": {
        target!.eState = E_VisuProductState.PLACED;
        latch(outfeedProducts, outfeed, tcp[0], tcp[1], tcpRz);
        target = undefined;
        phase = "idle";
        break;
      }
    }
  }

  /**
   * XTS loop: the queue head takes over the next product arriving under the start of the lower straight, follows it,
   * grips it, carries it faster to the spacing belt and releases it there; the mover then runs round to the queue.
   */
  function stepLoop(dtS: number): void {
    const outfeedX = (p: TrackedProduct) => productPosition(p, outfeed.stState.fBeltPosition)[0] - LOOP.x;
    const queued = loopMovers.filter((m) => m.mode === "queue").sort((a, b) => b.s - a.s);
    queued.forEach((m, rank) => {
      m.s = Math.min(m.s + LOOP.returnSpeed * dtS, LOOP_PERIMETER - rank * LOOP.slot);
    });
    const head = queued[0];
    if (head && head.s >= LOOP_PERIMETER - 1) {
      // Movers cannot overlap: the next product must be at least one slot behind the last mover following one.
      const lastTracked = Math.min(...loopMovers.filter((m) => m.mode === "track").map((m) => m.s), Infinity);
      const next = outfeedProducts.find(
        (p) =>
          p.eState === E_VisuProductState.DETECTED &&
          outfeedX(p) >= 0 &&
          outfeedX(p) < LOOP.grip &&
          lastTracked - outfeedX(p) >= LOOP.slot,
      );
      if (next) {
        next.eState = E_VisuProductState.ASSIGNED;
        next.nRobotId = LOOP.id;
        next.nMoverId = head.id;
        head.product = next;
        head.mode = "track";
      }
    }
    for (const m of loopMovers) {
      switch (m.mode) {
        case "track": {
          m.s = outfeedX(m.product!);
          if (m.s >= LOOP.grip) m.product!.eState = E_VisuProductState.PICKED;
          if (m.s >= LOOP.release) m.mode = "deliver";
          break;
        }
        case "deliver":
          m.s = Math.min(m.s + LOOP.deliverSpeed * dtS, LOOP.place);
          if (m.s >= LOOP.place) {
            m.product!.eState = E_VisuProductState.PLACED;
            latch(spacingProducts, spacing, LOOP.x + m.s, SPACING.y, m.product!.stLatchPose.fRz);
            m.product = undefined;
            m.mode = "return";
          }
          break;
        case "return":
          m.s += LOOP.returnSpeed * dtS;
          if (m.s >= LOOP_PERIMETER - LOOP.movers * LOOP.slot) m.mode = "queue";
          break;
        case "queue":
          break;
      }
    }
  }

  /**
   * XTS gantry: the movers follow up to four products on the spacing belt (the most downstream mover takes the
   * first product), then the Z axis lowers all grippers together, the X axes carry the products over the tray belt,
   * they are put down together and the movers return to their waiting positions.
   */
  function stepGantry(dtS: number): void {
    const trackPos = (p: TrackedProduct) => productPosition(p, spacing.stState.fBeltPosition)[0] - GANTRY.x;
    const trackEnd = GANTRY.modules * GANTRY.moduleLength;
    const byPosition = [...gantryMovers].sort((a, b) => b.position - a.position);
    const follow = () => {
      // Downstream first, so each mover can keep its distance to the one ahead.
      byPosition.forEach((m, i) => {
        const ahead = byPosition[i - 1];
        const limit = ahead ? ahead.position - GANTRY.gap : trackEnd - GANTRY.moverLength / 2;
        // A mover waits at its waiting position until its product passes underneath, then follows it.
        const wait = GANTRY.wait[m.id - 1]!;
        const goal = m.product ? Math.max(trackPos(m.product), wait) : wait;
        m.position = Math.min(approach(m.position, goal, GANTRY.trackSpeed * dtS), limit);
        if (m.product) m.c = approach(m.c, m.product.stLatchPose.fRz, 180 * dtS);
      });
    };
    switch (gantryPhase) {
      case "collect": {
        for (const m of byPosition) {
          if (m.product) continue;
          const next = spacingProducts
            .filter((p) => p.eState === E_VisuProductState.DETECTED && trackPos(p) < m.position && trackPos(p) > -500)
            .sort((a, b) => trackPos(b) - trackPos(a))[0];
          if (!next) break;
          next.eState = E_VisuProductState.ASSIGNED;
          next.nRobotId = GANTRY.id;
          next.nMoverId = m.id;
          m.product = next;
        }
        follow();
        const assigned = gantryMovers.filter((m) => m.product);
        const synced = (m: GantryMover) => Math.abs(m.position - trackPos(m.product!)) < 2;
        const nearEnd = byPosition[0]!.position >= trackEnd - 300;
        if ((assigned.length === gantryMovers.length && assigned.every(synced)) || (nearEnd && assigned.some(synced))) {
          for (const m of assigned) {
            if (synced(m)) continue;
            m.product!.eState = E_VisuProductState.DETECTED;
            m.product!.nRobotId = 0;
            m.product!.nMoverId = 0;
            m.product = undefined;
          }
          gantryPhase = "pickDown";
        }
        break;
      }
      case "pickDown":
        follow();
        gantryZ = approach(gantryZ, GANTRY.zDown, GANTRY.zSpeed * dtS);
        if (gantryZ === GANTRY.zDown) {
          for (const m of gantryMovers) {
            if (!m.product) continue;
            m.gripper = true;
            m.product.eState = E_VisuProductState.PICKED;
          }
          gantryPhase = "pickUp";
        }
        break;
      case "pickUp":
        gantryZ = approach(gantryZ, 0, GANTRY.zSpeed * dtS);
        if (gantryZ === 0) gantryPhase = "toTray";
        break;
      case "toTray": {
        let done = true;
        for (const m of gantryMovers) {
          m.x = approach(m.x, GANTRY.xTray, GANTRY.xSpeed * dtS);
          m.c = approach(m.c, 0, 180 * dtS);
          done &&= m.x === GANTRY.xTray && m.c === 0;
        }
        if (done) gantryPhase = "placeDown";
        break;
      }
      case "placeDown":
        gantryZ = approach(gantryZ, GANTRY.zDown, GANTRY.zSpeed * dtS);
        if (gantryZ === GANTRY.zDown) {
          for (const m of gantryMovers) {
            if (!m.product) continue;
            m.product.eState = E_VisuProductState.PLACED;
            // Turned by −90°: the gripper is at MCS x = track start + position, y = pose y − (X + offset).
            latch(trayProducts, tray, GANTRY.x + m.position, GANTRY.y - (m.x + GANTRY.toolOffsetX), 0);
            m.product = undefined;
            m.gripper = false;
          }
          gantryPhase = "placeUp";
        }
        break;
      case "placeUp":
        gantryZ = approach(gantryZ, 0, GANTRY.zSpeed * dtS);
        if (gantryZ === 0) gantryPhase = "return";
        break;
      case "return": {
        follow();
        let done = true;
        for (const m of gantryMovers) {
          m.x = approach(m.x, GANTRY.xBelt, GANTRY.xSpeed * dtS);
          done &&= m.x === GANTRY.xBelt && m.position === GANTRY.wait[m.id - 1];
        }
        if (done) gantryPhase = "collect";
        break;
      }
    }
  }

  /** Products in the hands of a loop or gantry mover stay in the register wherever they are. */
  const inUse = (p: TrackedProduct) =>
    p === target ||
    loopMovers.some((m) => m.product === p) ||
    gantryMovers.some((m) => m.product === p);

  function writeRegister(c: ST_VisuConveyor, products: TrackedProduct[], beltX: number, length: number): void {
    // The PLC drops entries some distance beyond the belt end.
    for (let i = products.length - 1; i >= 0; i--) {
      const x = productPosition(products[i]!, c.stState.fBeltPosition)[0] - beltX;
      if (x > length + REMOVE_BEYOND_END && !inUse(products[i]!)) products.splice(i, 1);
    }
    const visible = products.slice(0, MAX_PRODUCTS);
    c.stState.nProductCount = visible.length;
    c.stState.aProducts = [
      ...visible.map((p) => ({ ...p, stLatchPose: { ...p.stLatchPose } })),
      ...Array.from({ length: MAX_PRODUCTS - visible.length }, emptyProduct),
    ];
    c.stState.nTimestamp = now;
  }

  function writeRobot(): void {
    robot.stState.stActualTcp = { fX: tcp[0], fY: tcp[1], fZ: tcp[2], fRz: tcpRz };
    // Setpoint leads the actual position slightly, like a small following error.
    robot.stState.stSetpointTcp = { fX: tcp[0] + 2, fY: tcp[1], fZ: tcp[2] - 1, fRz: tcpRz };
    robot.stState.nTimestamp = now;
  }

  function writeXts(): void {
    loop.stState.nMoverCount = loopMovers.length;
    loopMovers.forEach((m, i) => {
      loop.stState.aMovers[i] = { nId: m.id, bValid: true, fPosition: m.s % LOOP_PERIMETER };
    });
    loop.stState.nTimestamp = now;
    gantry.stState.fZ = gantryZ;
    gantry.stState.nMoverCount = gantryMovers.length;
    gantryMovers.forEach((m, i) => {
      gantry.stState.aMovers[i] = {
        nId: m.id,
        bValid: true,
        fPosition: m.position,
        fX: m.x,
        fC: m.c,
        bGripperActive: m.gripper,
      };
    });
    gantry.stState.nTimestamp = now;
  }

  return {
    plc,
    step(dtMs) {
      const dtS = dtMs / 1000;
      now += BigInt(Math.round(dtMs * 1_000_000));
      infeed.stState.fBeltPosition += INFEED.speed * dtS;
      outfeed.stState.fBeltPosition += OUTFEED.speed * dtS;
      spacing.stState.fBeltPosition += SPACING.speed * dtS;
      tray.stState.fBeltPosition += TRAY.speed * dtS;

      sinceSpawn += dtMs;
      if (sinceSpawn >= SPAWN_INTERVAL_MS) {
        sinceSpawn = 0;
        latch(infeedProducts, infeed, INFEED.x + 100, INFEED.y + (random() - 0.5) * 240, (random() - 0.5) * 60);
      }

      stepRobot(dtS);
      stepLoop(dtS);
      stepGantry(dtS);
      writeRegister(infeed, infeedProducts, INFEED.x, INFEED.length);
      writeRegister(outfeed, outfeedProducts, OUTFEED.x, OUTFEED.length);
      writeRegister(spacing, spacingProducts, SPACING.x, SPACING.length);
      writeRegister(tray, trayProducts, TRAY.x, TRAY.length);
      writeRobot();
      writeXts();
    },
  };
}
