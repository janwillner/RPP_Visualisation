import { TrackModuleSchema, trackLength, trackPoint, type TrackModule, type Vec3 } from "@rpp/protocol";
import { InMemoryPlc } from "./in-memory-plc";
import { mapPlc } from "./plc-mapping";
import {
  noFault,
  MAX_PRODUCTS,
  body,
  cartesian,
  conveyor,
  defineMachine,
  delta,
  detector,
  emptyProduct,
  fingerStates,
  loopModules,
  trackModule,
  xtsGantry,
  xtsLoop,
  type ZoneSpec,
} from "./plc-builders";
import {
  E_VisuBodyRole,
  E_VisuBodyShape,
  E_VisuModuleKind,
  E_VisuProductShape,
  E_VisuProductState,
  type ST_VisuCartesian,
  type ST_VisuConveyor,
  type ST_VisuDelta,
  type ST_VisuDetector,
  type ST_VisuFingerState,
  type ST_VisuProduct,
  type ST_VisuXtsGantry,
  type ST_VisuXtsLoop,
} from "./plc-contract";

/**
 * Sample machine behind the same contract as a real PLC: four independent applications side by side, each line
 * starting at X = 0 and conveying along +X.
 * - Delta (Y = 0..900): a vision system over the infeed detects the products, a Delta picks them and places them
 *   onto the outfeed.
 * - Fxx (Y = 2500): products arrive irregularly on the Fxx infeed; an XTS loop puts them onto the Fxx outfeed with an
 *   even spacing.
 * - IDH (Y = 4100..4850): an XTS gantry with four movers picks from the IDH infeed in batches of up to four and
 *   places onto the tray belt.
 * - Cartesian (Y = 6500..7300): a Cartesian robot picks from the Cartesian infeed, turns each product by C = −90°,
 *   tilts it by A while lowering and places it onto the Cartesian outfeed. A light barrier detects the products on the
 *   Cartesian infeed; its beam lights up while one interrupts it.
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
const FXX_INFEED = { id: 3, path: "MAIN.stFxxInfeed", x: 0, y: 2500, length: 2000, speed: 150 };
const FXX_OUTFEED = { id: 4, path: "MAIN.stFxxOutfeed", x: 2400, y: 2500, length: 3000, speed: 300 };
const IDH_INFEED = { id: 5, path: "MAIN.stIdhInfeed", x: 0, y: 4500, length: 4000, speed: 200 };
const TRAY = { id: 6, path: "MAIN.stTrayBelt", x: 1300, y: 4100, length: 2000, speed: 80 };
const CART_INFEED = { id: 7, path: "MAIN.stCartesianInfeed", x: 0, y: 6500, length: 3000, speed: 150 };
const CART_OUTFEED = { id: 8, path: "MAIN.stCartesianOutfeed", x: 0, y: 7300, length: 3000, speed: 150 };
const ROBOT = { id: 10, path: "MAIN.stDelta1", x: 1500, y: 450, z: 1900 };
const GEOMETRY = { baseRadius: 200, effectorRadius: 50, upperArmLength: 400, lowerArmLength: 950 };
const PRODUCT = { type: 1, length: 120, width: 80, height: 40 };
/** A can, the second product type on the Delta infeed: as high as the standard product, so the robot moves alike. */
const CAN = { type: 2, diameter: 80 };
const PICK_ZONE = { start: 1100, end: 1900, allocationOffset: 300 };
/** Vision system over the infeed: its lens 800 mm above the belt, its field of view from 100 to 500 mm along the belt. */
const VISION = { id: 50, path: "MAIN.fbVision.vo_Visu", x: 300, field: 400, distance: 800 };
/** Light barrier at the side of the Cartesian infeed, its beam across the belt 20 mm above it. */
const SENSOR = { id: 51, path: "MAIN.fbSensor.vo_Visu", x: 300, beam: 500, height: 20 };
const PLACE_X = 1500;
const SPAWN_INTERVAL_MS = 700;
const TCP_SPEED = 2500; // mm/s
const HOVER = 120; // mm above the product top
/** Suction cup of the Delta, the IDH and the Fxx movers: it hangs below the flange, products below it. */
const SUCTION = { fDiameter: 40, fHeight: 50 };
/** Cartesian gripper below the flange: a central cup carries the product, two jaws close beside it. */
const CART_TOOL = {
  /** Flange to the cup's grip point (the product top). */
  length: 150,
  cup: { fDiameter: 40, fHeight: 40 },
  jaw: { fDiameter: 20, fHeight: 120 },
  /** Jaw top below the flange. */
  jawTop: 60,
  /** Jaw distance from the cup along the gripper's +X, closed on a 120 mm product and open. */
  jawClosed: 70,
  jawOpen: 120,
  jawSpeed: 300,
};
/** Products are removed from the register this far beyond the belt end, so "missed" stays visible briefly. */
const REMOVE_BEYOND_END = 300;

/** XTS loop above the Fxx infeed and outfeed; tool points at the product tops. */
const LOOP = {
  id: 20,
  path: "MAIN.fbFxx.stVisu",
  x: 1000,
  /** Straight modules per side: 10 × 250 mm, joined by two curve modules at each end. */
  straight: 10,
  toolOffset: 120,
  movers: 12,
  moverLength: 100,
  slot: 130,
  /** Track positions: products are gripped here and handed over here (loop x 3000 = Fxx outfeed x 600). */
  grip: 300,
  release: 600,
  place: 2000,
  deliverSpeed: 700,
  returnSpeed: 900,
};
const LOOP_MODULES = loopModules(LOOP.straight);
const LOOP_TRACK: TrackModule[] = LOOP_MODULES.map((m) => mapPlc(TrackModuleSchema, m));
const LOOP_PERIMETER = trackLength(LOOP_TRACK);

/**
 * Point and tangent angle (degrees about local Y) at track position s on the loop, in its local X-Z plane: the track
 * plane's u is local X and its v local Z, so a heading turns the mover by −heading about Y.
 */
function loopPoint(s: number): { point: Vec3; angle: number } {
  const p = trackPoint(LOOP_TRACK, s, true);
  return { point: [p.u, 0, p.v], angle: -p.heading };
}

const rad = (deg: number) => (deg * Math.PI) / 180;
/** Rz(c) · v and Rx(a) · v, degrees. */
const turnZ = (v: Vec3, c: number): Vec3 => [
  v[0] * Math.cos(rad(c)) - v[1] * Math.sin(rad(c)),
  v[0] * Math.sin(rad(c)) + v[1] * Math.cos(rad(c)),
  v[2],
];
const turnX = (v: Vec3, a: number): Vec3 => [
  v[0],
  v[1] * Math.cos(rad(a)) - v[2] * Math.sin(rad(a)),
  v[1] * Math.sin(rad(a)) + v[2] * Math.cos(rad(a)),
];
/** A component frame turned by −90° about Z (IDH, Cartesian): local (x, y, z) → MCS (x0 + y, y0 − x, z0 + z). */
const turnedFrame = (origin: Vec3, local: Vec3): Vec3 => [origin[0] + local[1], origin[1] - local[0], origin[2] + local[2]];

function finger(p: Vec3, rot: { rx?: number; ry?: number; rz?: number }, active: boolean): Partial<ST_VisuFingerState> {
  return {
    stPose: { fX: p[0], fY: p[1], fZ: p[2], fRx: rot.rx ?? 0, fRy: rot.ry ?? 0, fRz: rot.rz ?? 0 },
    bActive: active,
  };
}

/**
 * XTS gantry turned by −90°: its track (local +Y) runs along MCS +X above the IDH infeed, its X axes (local +X)
 * reach towards MCS −Y, over the IDH infeed at X = 200 and over the tray belt at X = 600.
 */
const GANTRY = {
  id: 30,
  path: "MAIN.fbIdh.stVisu",
  x: 1500,
  y: 4850,
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

/**
 * Cartesian robot turned by −90°: its X axis (local +X) reaches across the belts towards MCS −Y, over the outfeed at
 * X = 100 and over the infeed at X = 900; its Y axis (local +Y) runs along MCS +X from X = 1000.
 */
const CART = {
  id: 40,
  path: "MAIN.fbCartesian.stVisu",
  x: 1000,
  y: CART_OUTFEED.y + 100,
  /** Pick height Z = −550 puts the cup's grip point (A = 0) on the product top. */
  z: BELT_Z + PRODUCT.height + 550 + 150,
  xOutfeed: 100,
  xInfeed: 900,
  yHome: 200,
  yPlace: 500,
  zPick: -550,
  zTravel: -200,
  tilt: 20,
  turn: -90,
  xySpeed: 1500,
  zSpeed: 800,
  cSpeed: 180,
  aSpeed: 60,
  spawnIntervalMs: 2500,
};
type CartPhase = "idle" | "descend" | "lift" | "transfer" | "lower" | "straighten" | "release" | "rise";

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

const productTypes = [
  { nId: PRODUCT.type, fLength: PRODUCT.length, fWidth: PRODUCT.width, fHeight: PRODUCT.height },
  { nId: CAN.type, fLength: CAN.diameter, fWidth: CAN.diameter, fHeight: PRODUCT.height, eShape: E_VisuProductShape.CYLINDER },
];

const FAULT_PERIOD_MS = 20_000;
const FAULT_DURATION_MS = 5_000;

/**
 * The bodies _FB_VisuVision.m_Configure describes: housing above the lens, lens, field of view down to the belt.
 */
function visionBodies(field: number, distance: number) {
  const at = (fZ: number) => ({ fX: 0, fY: 0, fZ, fRx: 0, fRy: 0, fRz: 0 });
  return [
    body({ stPose: at(60), fLength: 100, fWidth: 80, fHeight: 140 }),
    body({ eShape: E_VisuBodyShape.CYLINDER, eRole: E_VisuBodyRole.SENSOR, stPose: at(0), fLength: 50, fWidth: 50, fHeight: 60 }),
    body({
      eShape: E_VisuBodyShape.FRUSTUM,
      eRole: E_VisuBodyRole.FIELD_OF_VIEW,
      stPose: at(-distance),
      fLength: field,
      fWidth: field,
      fHeight: distance,
      fTopLength: 50,
      fTopWidth: 50,
    }),
  ];
}

/** The bodies _FB_VisuSensor.m_Configure describes: the head and the beam along its local +Y. */
function sensorBodies(beam: number) {
  return [
    body({ eRole: E_VisuBodyRole.SENSOR, stPose: { fX: 0, fY: 0, fZ: -30, fRx: 0, fRy: 0, fRz: 0 }, fLength: 30, fWidth: 40, fHeight: 60 }),
    body({
      eShape: E_VisuBodyShape.CYLINDER,
      eRole: E_VisuBodyRole.BEAM,
      stPose: { fX: 0, fY: 20, fZ: 0, fRx: -90, fRy: 0, fRz: 0 },
      fLength: 8,
      fWidth: 8,
      fHeight: beam,
    }),
  ];
}

/** The simulated robots keep their conveyor coordinate system (CCS) in the middle of each zone. */
function centred(zones: ZoneSpec[]): ZoneSpec[] {
  return zones.map((z) => ({ ...z, fCcsOffset: (z.fStart + z.fEnd) / 2 }));
}

export function createSimulator(options: { seed?: number } = {}): Simulator {
  const random = mulberry32(options.seed ?? Date.now());
  const plc = new InMemoryPlc();
  const belt = (b: { x: number; y: number; length: number }) =>
    conveyor({ pose: { fX: b.x, fY: b.y, fZ: BELT_Z }, length: b.length, width: 400, productTypes });
  defineMachine(plc, [
    { id: INFEED.id, name: "Infeed", path: INFEED.path, kind: "conveyor", value: belt(INFEED) },
    { id: OUTFEED.id, name: "Outfeed", path: OUTFEED.path, kind: "conveyor", value: belt(OUTFEED) },
    { id: FXX_INFEED.id, name: "Fxx infeed", path: FXX_INFEED.path, kind: "conveyor", value: belt(FXX_INFEED) },
    { id: FXX_OUTFEED.id, name: "Fxx outfeed", path: FXX_OUTFEED.path, kind: "conveyor", value: belt(FXX_OUTFEED) },
    { id: IDH_INFEED.id, name: "IDH infeed", path: IDH_INFEED.path, kind: "conveyor", value: belt(IDH_INFEED) },
    { id: TRAY.id, name: "Tray belt", path: TRAY.path, kind: "conveyor", value: belt(TRAY) },
    {
      id: ROBOT.id,
      name: "Delta 1",
      path: ROBOT.path,
      kind: "delta",
      value: delta({
        pose: { fX: ROBOT.x, fY: ROBOT.y, fZ: ROBOT.z },
        ...GEOMETRY,
        fingers: [SUCTION],
        limitArea: { fXMin: -600, fXMax: 600, fYMin: -600, fYMax: 600, fZMin: -1500, fZMax: -700 },
        zones: centred([
          {
            nConveyorId: INFEED.id,
            fStart: PICK_ZONE.start,
            fEnd: PICK_ZONE.end,
            fAllocationOffset: PICK_ZONE.allocationOffset,
          },
          { nConveyorId: OUTFEED.id, fStart: PLACE_X - 300, fEnd: PLACE_X + 300 },
        ]),
      }),
    },
    {
      id: LOOP.id,
      name: "Fxx",
      path: LOOP.path,
      kind: "xtsLoop",
      value: xtsLoop({
        pose: { fX: LOOP.x, fY: FXX_INFEED.y, fZ: BELT_Z + PRODUCT.height + LOOP.toolOffset },
        modules: LOOP_MODULES,
        fingers: [SUCTION],
        zones: centred([
          {
            nConveyorId: FXX_INFEED.id,
            fStart: LOOP.x - FXX_INFEED.x,
            fEnd: LOOP.x - FXX_INFEED.x + LOOP.release,
          },
          {
            nConveyorId: FXX_OUTFEED.id,
            fStart: LOOP.x + LOOP.place - FXX_OUTFEED.x - 300,
            fEnd: LOOP.x + LOOP.place - FXX_OUTFEED.x + 100,
          },
        ]),
      }),
    },
    {
      id: GANTRY.id,
      name: "IDH",
      path: GANTRY.path,
      kind: "xtsGantry",
      value: xtsGantry({
        pose: { fX: GANTRY.x, fY: GANTRY.y, fZ: GANTRY.z, fRz: -90 },
        modules: Array.from({ length: GANTRY.modules }, () => trackModule(E_VisuModuleKind.STRAIGHT, GANTRY.moduleLength)),
        fingers: [SUCTION],
        zones: centred([
          {
            nConveyorId: IDH_INFEED.id,
            fStart: GANTRY.x - IDH_INFEED.x,
            fEnd: GANTRY.x - IDH_INFEED.x + GANTRY.modules * GANTRY.moduleLength,
          },
          {
            nConveyorId: TRAY.id,
            fStart: GANTRY.x - TRAY.x,
            fEnd: GANTRY.x - TRAY.x + GANTRY.modules * GANTRY.moduleLength,
          },
        ]),
      }),
    },
    {
      id: VISION.id,
      name: "Vision 1",
      path: VISION.path,
      kind: "vision",
      value: detector({
        pose: { fX: INFEED.x + VISION.x, fY: INFEED.y, fZ: BELT_Z + VISION.distance },
        zones: [
          {
            nConveyorId: INFEED.id,
            fStart: VISION.x - VISION.field / 2,
            fEnd: VISION.x + VISION.field / 2,
            fCcsOffset: VISION.x,
          },
        ],
        bodies: visionBodies(VISION.field, VISION.distance),
      }),
    },
    { id: CART_INFEED.id, name: "Cartesian infeed", path: CART_INFEED.path, kind: "conveyor", value: belt(CART_INFEED) },
    {
      id: SENSOR.id,
      name: "Light barrier",
      path: SENSOR.path,
      kind: "sensor",
      value: detector({
        // At the right belt edge (local −Y), the beam across the belt towards +Y.
        pose: { fX: CART_INFEED.x + SENSOR.x, fY: CART_INFEED.y - 250, fZ: BELT_Z + SENSOR.height },
        zones: [{ nConveyorId: CART_INFEED.id, fStart: SENSOR.x, fEnd: SENSOR.x, fCcsOffset: SENSOR.x }],
        bodies: sensorBodies(SENSOR.beam),
      }),
    },
    { id: CART_OUTFEED.id, name: "Cartesian outfeed", path: CART_OUTFEED.path, kind: "conveyor", value: belt(CART_OUTFEED) },
    {
      id: CART.id,
      name: "Cartesian",
      path: CART.path,
      kind: "cartesian",
      value: cartesian({
        pose: { fX: CART.x, fY: CART.y, fZ: CART.z, fRz: -90 },
        fingers: [CART_TOOL.cup, CART_TOOL.jaw, CART_TOOL.jaw],
        zones: centred([
          { nConveyorId: CART_INFEED.id, fStart: CART.x, fEnd: CART.x + 1000 },
          {
            nConveyorId: CART_OUTFEED.id,
            fStart: CART.x + CART.yPlace - 200,
            fEnd: CART.x + CART.yPlace + 200,
          },
        ]),
      }),
    },
  ]);
  const infeed = plc.get<ST_VisuConveyor>(INFEED.path);
  const outfeed = plc.get<ST_VisuConveyor>(OUTFEED.path);
  const fxxInfeed = plc.get<ST_VisuConveyor>(FXX_INFEED.path);
  const fxxOutfeed = plc.get<ST_VisuConveyor>(FXX_OUTFEED.path);
  const idhInfeed = plc.get<ST_VisuConveyor>(IDH_INFEED.path);
  const tray = plc.get<ST_VisuConveyor>(TRAY.path);
  const cartInfeed = plc.get<ST_VisuConveyor>(CART_INFEED.path);
  const cartOutfeed = plc.get<ST_VisuConveyor>(CART_OUTFEED.path);
  const cart = plc.get<ST_VisuCartesian>(CART.path);
  const lightBarrier = plc.get<ST_VisuDetector>(SENSOR.path);
  const vision = plc.get<ST_VisuDetector>(VISION.path);
  const robot = plc.get<ST_VisuDelta>(ROBOT.path);
  robot.stConfig.stWorkingArea = { fRadius: 700, fZMin: -1300, fZMax: -700, fConeHeight: 200, fConeBottomRadius: 400 };
  const loop = plc.get<ST_VisuXtsLoop>(LOOP.path);
  // The flange sits one cup height closer to the track, so the cup's grip point is the former tool point.
  loop.stConfig.fToolOffset = LOOP.toolOffset - SUCTION.fHeight;
  loop.stConfig.fMoverLength = LOOP.moverLength;
  const gantry = plc.get<ST_VisuXtsGantry>(GANTRY.path);
  Object.assign(gantry.stConfig, {
    fXMin: 0,
    fXMax: 700,
    fZMin: GANTRY.zDown,
    fZMax: 0,
    fToolOffsetX: GANTRY.toolOffsetX,
    fToolOffsetZ: GANTRY.toolOffsetZ + SUCTION.fHeight,
    fMoverLength: GANTRY.moverLength,
  });

  // Simulated time in ms; drives the demo faults: every 20 s one Fxx mover and one IDH mover are in a fault for 5 s,
  // the Delta and the Fxx's first far curve module at other times.
  let simMs = 0;
  const faultWindow = (start: number) => {
    const phase = simMs % FAULT_PERIOD_MS;
    return phase >= start && phase < start + FAULT_DURATION_MS;
  };
  const fault = (active: boolean, sMessage: string) => (active ? { bActive: true, sMessage } : noFault());

  // DC time: ns since 2000-01-01.
  let now = BigInt(Date.UTC(2026, 0, 1) - Date.UTC(2000, 0, 1)) * 1_000_000n;
  let nextId = 1;
  let sinceSpawn = SPAWN_INTERVAL_MS;
  let sinceFxxSpawn = 0;
  let fxxSpawnInterval = 600;
  let sinceIdhSpawn = 0;
  let idhSpawnInterval = 800;
  const infeedProducts: TrackedProduct[] = [];
  const outfeedProducts: TrackedProduct[] = [];
  const fxxInfeedProducts: TrackedProduct[] = [];
  const fxxOutfeedProducts: TrackedProduct[] = [];
  const idhInfeedProducts: TrackedProduct[] = [];
  const trayProducts: TrackedProduct[] = [];
  const cartInfeedProducts: TrackedProduct[] = [];
  const cartOutfeedProducts: TrackedProduct[] = [];
  let sinceCartSpawn = 0;

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

  // C and A turn and tilt the gripper below the flange; the PLC reports them only through the finger poses.
  const axes = { x: CART.xInfeed, y: CART.yHome, z: CART.zTravel, c: 0, a: 0, gripper: false, jaw: CART_TOOL.jawOpen };
  let cartPhase: CartPhase = "idle";
  let cartTarget: TrackedProduct | undefined;

  /** Current MCS position of a tracked product's bottom centre on a belt along MCS +X. */
  function productPosition(p: TrackedProduct, beltPosition: number): Vec3 {
    return [p.stLatchPose.fX + (beltPosition - p.fLatchBeltPosition), p.stLatchPose.fY, p.stLatchPose.fZ];
  }

  /**
   * Takes a product out of the register of the conveyor it was picked from, once a robot has put it down elsewhere:
   * it no longer lies on that belt (PLACED means it lies on the belt whose register holds it).
   */
  function remove(products: TrackedProduct[], p: TrackedProduct): void {
    const i = products.indexOf(p);
    if (i >= 0) products.splice(i, 1);
  }

  /**
   * Enters a product into a conveyor's register: DETECTED where it arrives, PLACED where a robot puts it down, as the
   * contract asks (an outfeed product past the belt end is otherwise shown as missed).
   */
  function latch(
    products: TrackedProduct[],
    c: ST_VisuConveyor,
    x: number,
    y: number,
    rz: number,
    eState: TrackedProduct["eState"] = E_VisuProductState.DETECTED,
    productType: number = PRODUCT.type,
    detectorId = 0,
  ): void {
    products.push({
      ...emptyProduct(),
      nId: nextId++,
      bValid: true,
      stLatchPose: { fX: x, fY: y, fZ: BELT_Z, fRz: rz },
      fLatchBeltPosition: c.stState.fBeltPosition,
      eState,
      nProductType: productType,
      nDetectorId: detectorId,
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
          return p.eState === E_VisuProductState.DETECTED && x >= PICK_ZONE.start && x <= PICK_ZONE.end - PICK_ZONE.allocationOffset;
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
          target!.nFingerId = 1;
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
        remove(infeedProducts, target!);
        latch(outfeedProducts, outfeed, tcp[0], tcp[1], tcpRz, E_VisuProductState.PLACED, target!.nProductType);
        target = undefined;
        phase = "idle";
        break;
      }
    }
  }

  /**
   * XTS loop: the queue head takes over the next product arriving on the Fxx infeed under the start of the lower
   * straight, follows it, grips it, carries it faster to the Fxx outfeed and releases it there; the mover then runs
   * round to the queue.
   */
  function stepLoop(dtS: number): void {
    const outfeedX = (p: TrackedProduct) => productPosition(p, fxxInfeed.stState.fBeltPosition)[0] - LOOP.x;
    const queued = loopMovers.filter((m) => m.mode === "queue").sort((a, b) => b.s - a.s);
    queued.forEach((m, rank) => {
      m.s = Math.min(m.s + LOOP.returnSpeed * dtS, LOOP_PERIMETER - rank * LOOP.slot);
    });
    const head = queued[0];
    if (head && head.s >= LOOP_PERIMETER - 1) {
      // Movers cannot overlap: the next product must be at least one slot behind the last mover following one.
      const lastTracked = Math.min(...loopMovers.filter((m) => m.mode === "track").map((m) => m.s), Infinity);
      const next = fxxInfeedProducts.find(
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
          if (m.s >= LOOP.grip) {
            m.product!.eState = E_VisuProductState.PICKED;
            m.product!.nFingerId = 1;
          }
          if (m.s >= LOOP.release) m.mode = "deliver";
          break;
        }
        case "deliver":
          m.s = Math.min(m.s + LOOP.deliverSpeed * dtS, LOOP.place);
          if (m.s >= LOOP.place) {
            remove(fxxInfeedProducts, m.product!);
            latch(
              fxxOutfeedProducts,
              fxxOutfeed,
              LOOP.x + m.s,
              FXX_OUTFEED.y,
              m.product!.stLatchPose.fRz,
              E_VisuProductState.PLACED,
            );
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
   * XTS gantry: the movers follow up to four products on the IDH infeed (the most downstream mover takes the
   * first product), then the Z axis lowers all grippers together, the X axes carry the products over the tray belt,
   * they are put down together and the movers return to their waiting positions.
   */
  function stepGantry(dtS: number): void {
    const trackPos = (p: TrackedProduct) => productPosition(p, idhInfeed.stState.fBeltPosition)[0] - GANTRY.x;
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
          const next = idhInfeedProducts
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
            m.product.nFingerId = 1;
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
            remove(idhInfeedProducts, m.product);
            // Turned by −90°: the gripper is at MCS x = track start + position, y = pose y − (X + offset).
            latch(trayProducts, tray, GANTRY.x + m.position, GANTRY.y - (m.x + GANTRY.toolOffsetX), 0, E_VisuProductState.PLACED);
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

  /**
   * Cartesian robot: follows a product on the Cartesian infeed in Y with the gripper turned onto it (C), picks it,
   * carries it across to the outfeed while turning it by a further −90°, tilts it by A while lowering, straightens it
   * and places it.
   */
  function stepCartesian(dtS: number): void {
    axes.jaw = approach(axes.jaw, axes.gripper ? CART_TOOL.jawClosed : CART_TOOL.jawOpen, CART_TOOL.jawSpeed * dtS);
    // Robot Y of a product on the infeed: its MCS x relative to the robot origin.
    const productY = (p: TrackedProduct) => productPosition(p, cartInfeed.stState.fBeltPosition)[0] - CART.x;
    const move = (goal: Partial<Record<"x" | "y" | "z" | "c" | "a", number>>) => {
      const speeds = { x: CART.xySpeed, y: CART.xySpeed, z: CART.zSpeed, c: CART.cSpeed, a: CART.aSpeed };
      let done = true;
      for (const k of ["x", "y", "z", "c", "a"] as const) {
        const g = goal[k];
        if (g === undefined) continue;
        axes[k] = approach(axes[k], g, speeds[k] * dtS);
        done &&= axes[k] === g;
      }
      return done;
    };
    // The gripper's +X in the MCS is pose rz (−90°) + C; it is turned onto the product's orientation.
    const pickC = (p: TrackedProduct) => p.stLatchPose.fRz + 90;
    switch (cartPhase) {
      case "idle": {
        cartTarget = cartInfeedProducts.find(
          (p) => p.eState === E_VisuProductState.DETECTED && productY(p) >= 100 && productY(p) <= 600,
        );
        if (cartTarget) {
          cartTarget.eState = E_VisuProductState.ASSIGNED;
          cartTarget.nRobotId = CART.id;
          cartPhase = "descend";
        } else {
          move({ x: CART.xInfeed, y: CART.yHome, z: CART.zTravel, c: 0, a: 0 });
        }
        break;
      }
      case "descend": {
        const y = productY(cartTarget!);
        if (y > 1000) {
          // Out of reach: give up, it will be missed.
          cartTarget!.eState = E_VisuProductState.DETECTED;
          cartTarget!.nRobotId = 0;
          cartTarget = undefined;
          cartPhase = "rise";
          break;
        }
        // Lowers only once above the product with the gripper turned onto it.
        const above = move({ x: CART.xInfeed, y, c: pickC(cartTarget!) });
        if (above && move({ z: CART.zPick })) {
          cartTarget!.eState = E_VisuProductState.PICKED;
          cartTarget!.nFingerId = 1;
          axes.gripper = true;
          cartPhase = "lift";
        }
        break;
      }
      case "lift":
        if (move({ z: CART.zTravel })) cartPhase = "transfer";
        break;
      case "transfer":
        if (move({ x: CART.xOutfeed, y: CART.yPlace, c: pickC(cartTarget!) + CART.turn })) cartPhase = "lower";
        break;
      case "lower":
        if (move({ z: CART.zPick, a: CART.tilt })) cartPhase = "straighten";
        break;
      case "straighten":
        if (move({ a: 0 })) cartPhase = "release";
        break;
      case "release": {
        remove(cartInfeedProducts, cartTarget!);
        // Turned by −90°: the TCP (A = 0) is at MCS x = origin + Y, y = origin − X; the product keeps the gripper turn.
        latch(cartOutfeedProducts, cartOutfeed, CART.x + axes.y, CART.y - axes.x, -90 + axes.c, E_VisuProductState.PLACED);
        cartTarget = undefined;
        axes.gripper = false;
        cartPhase = "rise";
        break;
      }
      case "rise":
        if (move({ z: CART.zTravel })) cartPhase = "idle";
        break;
    }
  }

  /** Products in the hands of a loop or gantry mover stay in the register wherever they are. */
  const inUse = (p: TrackedProduct) =>
    p === target ||
    p === cartTarget ||
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
    // `tcp` is where the cup grips; the flange (the reported TCP) is one cup height above it.
    const flange: Vec3 = [tcp[0], tcp[1], tcp[2] + SUCTION.fHeight];
    robot.stState.stActualTcp = { fX: flange[0], fY: flange[1], fZ: flange[2] };
    // Setpoint leads the actual position slightly, like a small following error.
    robot.stState.stSetpointTcp = { fX: flange[0] + 2, fY: flange[1], fZ: flange[2] - 1 };
    robot.stState.aFingerStates = fingerStates([
      finger(flange, { rz: tcpRz }, target?.eState === E_VisuProductState.PICKED),
    ]);
    robot.stState.stFault = fault(faultWindow(4_000), "Drive 2: overtemperature");
    robot.stState.nTimestamp = now;
  }

  /** The light barrier's beam is interrupted while a product on the belt covers it; both report every cycle. */
  function writeDetectors(): void {
    const beamX = CART_INFEED.x + SENSOR.x;
    const interrupted = cartInfeedProducts.some((p) => {
      if (p.eState === E_VisuProductState.PICKED) return false;
      return Math.abs(productPosition(p, cartInfeed.stState.fBeltPosition)[0] - beamX) <= PRODUCT.length / 2;
    });
    lightBarrier.stState.aBodyStates[1]!.bActive = interrupted;
    lightBarrier.stState.nTimestamp = now;
    vision.stState.nTimestamp = now;
  }

  function writeXts(): void {
    loop.stState.nMoverCount = loopMovers.length;
    loopMovers.forEach((m, i) => {
      const { point, angle } = loopPoint(m.s);
      // The flange lies outwards (mover −Z, turned about Y by the tangent angle) from the track point.
      const d = LOOP.toolOffset - SUCTION.fHeight;
      const origin: Vec3 = [LOOP.x, FXX_INFEED.y, BELT_Z + PRODUCT.height + LOOP.toolOffset];
      const flange: Vec3 = [
        origin[0] + point[0] - d * Math.sin(rad(angle)),
        origin[1] + point[1],
        origin[2] + point[2] - d * Math.cos(rad(angle)),
      ];
      loop.stState.aMovers[i] = {
        nId: m.id,
        bValid: true,
        fPosition: m.s % LOOP_PERIMETER,
        aFingerStates: fingerStates([finger(flange, { ry: angle }, m.product?.eState === E_VisuProductState.PICKED)]),
        stFault: fault(i === 2 && faultWindow(10_000), "Following error"),
      };
    });
    loop.stState.aModuleStates[LOOP.straight]!.stFault = fault(faultWindow(15_000), "Overtemperature");
    loop.stState.nTimestamp = now;
    gantry.stState.fZ = gantryZ;
    gantry.stState.nMoverCount = gantryMovers.length;
    gantryMovers.forEach((m, i) => {
      gantry.stState.aMovers[i] = {
        nId: m.id,
        bValid: true,
        fPosition: m.position,
        fX: m.x,
        bGripperActive: m.gripper,
        aFingerStates: fingerStates([
          finger(
            turnedFrame([GANTRY.x, GANTRY.y, GANTRY.z], [
              m.x + GANTRY.toolOffsetX,
              m.position,
              gantryZ + GANTRY.toolOffsetZ + SUCTION.fHeight,
            ]),
            { rz: -90 + m.c },
            m.gripper,
          ),
        ]),
        stFault: fault(i === 1 && faultWindow(12_000), "Vacuum not reached"),
      };
    });
    gantry.stState.nTimestamp = now;
    // Finger frames: flange + Rz(C) · Rx(A) · offset in the robot frame, then into the MCS.
    const cartFinger = (offset: Vec3) =>
      finger(
        turnedFrame([CART.x, CART.y, CART.z], (() => {
          const v = turnZ(turnX(offset, axes.a), axes.c);
          return [axes.x + v[0], axes.y + v[1], axes.z + v[2]] as Vec3;
        })()),
        { rx: axes.a, rz: -90 + axes.c },
        axes.gripper,
      );
    Object.assign(cart.stState, {
      nTimestamp: now,
      fX: axes.x,
      fY: axes.y,
      fZ: axes.z,
      bGripperActive: axes.gripper,
      aFingerStates: fingerStates([
        cartFinger([0, 0, -(CART_TOOL.length - CART_TOOL.cup.fHeight)]),
        cartFinger([axes.jaw, 0, -CART_TOOL.jawTop]),
        cartFinger([-axes.jaw, 0, -CART_TOOL.jawTop]),
      ]),
    });
  }

  return {
    plc,
    step(dtMs) {
      const dtS = dtMs / 1000;
      simMs += dtMs;
      now += BigInt(Math.round(dtMs * 1_000_000));
      infeed.stState.fBeltPosition += INFEED.speed * dtS;
      outfeed.stState.fBeltPosition += OUTFEED.speed * dtS;
      fxxInfeed.stState.fBeltPosition += FXX_INFEED.speed * dtS;
      fxxOutfeed.stState.fBeltPosition += FXX_OUTFEED.speed * dtS;
      idhInfeed.stState.fBeltPosition += IDH_INFEED.speed * dtS;
      tray.stState.fBeltPosition += TRAY.speed * dtS;
      cartInfeed.stState.fBeltPosition += CART_INFEED.speed * dtS;
      cartOutfeed.stState.fBeltPosition += CART_OUTFEED.speed * dtS;

      sinceSpawn += dtMs;
      if (sinceSpawn >= SPAWN_INTERVAL_MS) {
        sinceSpawn = 0;
        // About one product in three on the Delta infeed is a can.
        const type = random() < 1 / 3 ? CAN.type : PRODUCT.type;
        // The vision system sees each product in the middle of its field of view.
        const x = INFEED.x + VISION.x;
        const y = INFEED.y + (random() - 0.5) * 240;
        latch(infeedProducts, infeed, x, y, (random() - 0.5) * 60, E_VisuProductState.DETECTED, type, VISION.id);
      }
      // Irregular gaps on the Fxx infeed: the loop evens them out.
      sinceFxxSpawn += dtMs;
      if (sinceFxxSpawn >= fxxSpawnInterval) {
        sinceFxxSpawn = 0;
        fxxSpawnInterval = 400 + random() * 1200;
        latch(fxxInfeedProducts, fxxInfeed, FXX_INFEED.x + 100, FXX_INFEED.y, 0);
      }
      sinceIdhSpawn += dtMs;
      if (sinceIdhSpawn >= idhSpawnInterval) {
        sinceIdhSpawn = 0;
        idhSpawnInterval = 600 + random() * 600;
        latch(idhInfeedProducts, idhInfeed, IDH_INFEED.x + 100, IDH_INFEED.y, (random() - 0.5) * 60);
      }

      sinceCartSpawn += dtMs;
      if (sinceCartSpawn >= CART.spawnIntervalMs) {
        sinceCartSpawn = 0;
        // Latched when its front edge reaches the light barrier; it covers the beam while it passes.
        const x = CART_INFEED.x + SENSOR.x - PRODUCT.length / 2;
        latch(cartInfeedProducts, cartInfeed, x, CART_INFEED.y, (random() - 0.5) * 60, E_VisuProductState.DETECTED, PRODUCT.type, SENSOR.id);
      }

      stepRobot(dtS);
      stepCartesian(dtS);
      stepLoop(dtS);
      stepGantry(dtS);
      writeRegister(infeed, infeedProducts, INFEED.x, INFEED.length);
      writeRegister(outfeed, outfeedProducts, OUTFEED.x, OUTFEED.length);
      writeRegister(fxxInfeed, fxxInfeedProducts, FXX_INFEED.x, FXX_INFEED.length);
      writeRegister(fxxOutfeed, fxxOutfeedProducts, FXX_OUTFEED.x, FXX_OUTFEED.length);
      writeRegister(idhInfeed, idhInfeedProducts, IDH_INFEED.x, IDH_INFEED.length);
      writeRegister(tray, trayProducts, TRAY.x, TRAY.length);
      writeRegister(cartInfeed, cartInfeedProducts, CART_INFEED.x, CART_INFEED.length);
      writeRegister(cartOutfeed, cartOutfeedProducts, CART_OUTFEED.x, CART_OUTFEED.length);
      writeRobot();
      writeXts();
      writeDetectors();
    },
  };
}
