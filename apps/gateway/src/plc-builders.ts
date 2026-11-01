import { PROTOCOL_VERSION } from "@rpp/protocol";
import {
  E_VisuComponentType,
  E_VisuProductShape,
  E_VisuBodyRole,
  E_VisuBodyShape,
  E_VisuProductState,
  MANIFEST_PATH,
  PLC_TYPES,
  type ST_VisuCartesian,
  type ST_VisuCartesianState,
  type ST_VisuBody,
  type ST_VisuBodyState,
  type ST_VisuConveyor,
  type ST_VisuDetector,
  type ST_VisuDelta,
  type ST_VisuFault,
  type ST_VisuFinger,
  type ST_VisuFingerState,
  type ST_VisuManifest,
  type ST_VisuManifestEntry,
  type ST_VisuPose,
  type ST_VisuPosition,
  type ST_VisuProduct,
  type ST_VisuProductType,
  type ST_VisuGantryMover,
  type ST_VisuLoopMover,
  type ST_VisuXtsGantry,
  type ST_VisuXtsLoop,
  type ST_VisuLimitArea,
  type ST_VisuZone,
} from "./plc-contract";
import type { InMemoryPlc } from "./in-memory-plc";

/** Library defaults (constants in Syn_Visu, overridable per project). */
export const MAX_MANIFEST_ENTRIES = 32;
export const MAX_PRODUCTS = 128;
export const MAX_PRODUCT_TYPES = 8;
export const MAX_ZONES = 8;
export const MAX_MOVERS = 40;
export const MAX_FINGERS = 8;
export const MAX_BODIES = 16;

export function noFault(): ST_VisuFault {
  return { bActive: false, sMessage: "" };
}

export function emptyFingerState(): ST_VisuFingerState {
  return { stPose: pose(), bActive: false };
}

/** A full finger state array from the given states. */
export function fingerStates(states: Partial<ST_VisuFingerState>[] = []): ST_VisuFingerState[] {
  return padded(
    states.map((s) => ({ ...emptyFingerState(), ...s })),
    MAX_FINGERS,
    emptyFingerState,
  );
}

function fingerConfig(spec: { fingers?: ST_VisuFinger[] }) {
  const fingers = spec.fingers ?? [];
  return { nFingerCount: fingers.length, aFingers: padded(fingers, MAX_FINGERS, () => ({ fDiameter: 0, fHeight: 0 })) };
}

export function pose(p: Partial<ST_VisuPose> = {}): ST_VisuPose {
  return { fX: 0, fY: 0, fZ: 0, fRx: 0, fRy: 0, fRz: 0, ...p };
}

export function emptyProduct(): ST_VisuProduct {
  return {
    nId: 0,
    bValid: false,
    stLatchPose: { fX: 0, fY: 0, fZ: 0, fRz: 0 },
    fLatchBeltPosition: 0,
    eState: E_VisuProductState.DETECTED,
    nRobotId: 0,
    nMoverId: 0,
    nFingerId: 0,
    nProductType: 0,
    nDetectorId: 0,
  };
}

function emptyZone(): ST_VisuZone {
  return { nConveyorId: 0, fStart: 0, fEnd: 0, fAllocationOffset: 0, fCcsOffset: 0 };
}

/** A zone as tests and the simulator write it; the allocation offset defaults to 0. */
export type ZoneSpec = Omit<ST_VisuZone, "fAllocationOffset" | "fCcsOffset"> & {
  fAllocationOffset?: number;
  fCcsOffset?: number;
};

function zoneList(spec: { zones?: ZoneSpec[] }): ST_VisuZone[] {
  return (spec.zones ?? []).map((z) => ({ fAllocationOffset: 0, fCcsOffset: 0, ...z }));
}

/** Every config's origin shift; zero unless given. */
function originShift(spec: { originShift?: Partial<ST_VisuPosition> }): { stOriginShift: ST_VisuPosition } {
  return { stOriginShift: { fX: 0, fY: 0, fZ: 0, ...spec.originShift } };
}

function padded<T>(items: T[], size: number, empty: () => T): T[] {
  return [...items, ...Array.from({ length: Math.max(0, size - items.length) }, empty)];
}

export interface ConveyorSpec {
  pose?: Partial<ST_VisuPose>;
  originShift?: Partial<ST_VisuPosition>;
  length?: number;
  width?: number;
  productTypes?: (Omit<ST_VisuProductType, "eShape" | "fCornerRadius"> & Partial<ST_VisuProductType>)[];
  beltPosition?: number;
  timestamp?: bigint;
  products?: Partial<ST_VisuProduct>[];
  fault?: ST_VisuFault;
}

/** A product type, a box unless its shape is given. */
function productType(t: NonNullable<ConveyorSpec["productTypes"]>[number]): ST_VisuProductType {
  return { eShape: E_VisuProductShape.BOX, fCornerRadius: 0, ...t };
}

export function conveyor(spec: ConveyorSpec = {}): ST_VisuConveyor {
  const productTypes = (spec.productTypes ?? [{ nId: 1, fLength: 100, fWidth: 80, fHeight: 50 }]).map(productType);
  const products = (spec.products ?? []).map((p) => ({ ...emptyProduct(), bValid: true, ...p }));
  return {
    stConfig: {
      stPose: pose(spec.pose),
      fLength: spec.length ?? 2000,
      fWidth: spec.width ?? 400,
      nProductTypeCount: productTypes.length,
      aProductTypes: padded(productTypes, MAX_PRODUCT_TYPES, () => productType({ nId: 0, fLength: 0, fWidth: 0, fHeight: 0 })),
      ...originShift(spec),
    },
    stState: {
      nTimestamp: spec.timestamp ?? 0n,
      fBeltPosition: spec.beltPosition ?? 0,
      nProductCount: products.length,
      aProducts: padded(products, MAX_PRODUCTS, emptyProduct),
      stFault: spec.fault ?? noFault(),
    },
  };
}

export interface DeltaSpec {
  pose?: Partial<ST_VisuPose>;
  originShift?: Partial<ST_VisuPosition>;
  baseRadius?: number;
  effectorRadius?: number;
  upperArmLength?: number;
  lowerArmLength?: number;
  fingers?: ST_VisuFinger[];
  /** Activates the limit area. */
  limitArea?: Omit<ST_VisuLimitArea, "bActive">;
  zones?: ZoneSpec[];
  timestamp?: bigint;
  fault?: ST_VisuFault;
}

export function delta(spec: DeltaSpec = {}): ST_VisuDelta {
  const zones = zoneList(spec);
  return {
    stConfig: {
      stPose: pose(spec.pose),
      fBaseRadius: spec.baseRadius ?? 200,
      fEffectorRadius: spec.effectorRadius ?? 50,
      fUpperArmLength: spec.upperArmLength ?? 350,
      fLowerArmLength: spec.lowerArmLength ?? 800,
      stWorkingArea: { fRadius: 600, fZMin: -1100, fZMax: -600, fConeHeight: 0, fConeBottomRadius: 0 },
      stLimitArea: spec.limitArea
        ? { ...spec.limitArea, bActive: true }
        : { fXMin: 0, fXMax: 0, fYMin: 0, fYMax: 0, fZMin: 0, fZMax: 0, bActive: false },
      nZoneCount: zones.length,
      aZones: padded(zones, MAX_ZONES, emptyZone),
      ...fingerConfig(spec),
      ...originShift(spec),
    },
    stState: {
      nTimestamp: spec.timestamp ?? 0n,
      stActualTcp: { fX: 0, fY: 0, fZ: 0 },
      stSetpointTcp: { fX: 0, fY: 0, fZ: 0 },
      aFingerStates: fingerStates(),
      stFault: spec.fault ?? noFault(),
    },
  };
}

export interface XtsGantrySpec {
  pose?: Partial<ST_VisuPose>;
  originShift?: Partial<ST_VisuPosition>;
  moduleCount?: number;
  moduleLength?: number;
  zones?: ZoneSpec[];
  fingers?: ST_VisuFinger[];
  z?: number;
  movers?: Partial<ST_VisuGantryMover>[];
  timestamp?: bigint;
  fault?: ST_VisuFault;
}

export function xtsGantry(spec: XtsGantrySpec = {}): ST_VisuXtsGantry {
  const zones = zoneList(spec);
  const empty = (): ST_VisuGantryMover => ({
    nId: 0,
    bValid: false,
    fPosition: 0,
    fX: 0,
    bGripperActive: false,
    aFingerStates: fingerStates(),
    stFault: noFault(),
  });
  const movers = (spec.movers ?? []).map((m) => ({ ...empty(), bValid: true, ...m }));
  return {
    stConfig: {
      stPose: pose(spec.pose),
      nModuleCount: spec.moduleCount ?? 3,
      fModuleLength: spec.moduleLength ?? 1000,
      fXMin: -50,
      fXMax: 300,
      fZMin: -200,
      fZMax: 0,
      fToolOffsetX: 150,
      fToolOffsetZ: -400,
      fMoverLength: 155,
      fMoverWidth: 80,
      nZoneCount: zones.length,
      aZones: padded(zones, MAX_ZONES, emptyZone),
      ...fingerConfig(spec),
      ...originShift(spec),
    },
    stState: {
      nTimestamp: spec.timestamp ?? 0n,
      fZ: spec.z ?? 0,
      nMoverCount: movers.length,
      aMovers: padded(movers, MAX_MOVERS, empty),
      stFault: spec.fault ?? noFault(),
    },
  };
}

export interface XtsLoopSpec {
  pose?: Partial<ST_VisuPose>;
  originShift?: Partial<ST_VisuPosition>;
  straightLength?: number;
  curveRadius?: number;
  zones?: ZoneSpec[];
  fingers?: ST_VisuFinger[];
  movers?: Partial<ST_VisuLoopMover>[];
  timestamp?: bigint;
  fault?: ST_VisuFault;
}

export function xtsLoop(spec: XtsLoopSpec = {}): ST_VisuXtsLoop {
  const zones = zoneList(spec);
  const empty = (): ST_VisuLoopMover => ({
    nId: 0,
    bValid: false,
    fPosition: 0,
    aFingerStates: fingerStates(),
    stFault: noFault(),
  });
  const movers = (spec.movers ?? []).map((m) => ({ ...empty(), bValid: true, ...m }));
  return {
    stConfig: {
      stPose: pose(spec.pose),
      fStraightLength: spec.straightLength ?? 2000,
      fCurveRadius: spec.curveRadius ?? 250,
      fToolOffset: 120,
      fMoverLength: 100,
      fMoverWidth: 60,
      nZoneCount: zones.length,
      aZones: padded(zones, MAX_ZONES, emptyZone),
      ...fingerConfig(spec),
      ...originShift(spec),
    },
    stState: {
      nTimestamp: spec.timestamp ?? 0n,
      nMoverCount: movers.length,
      aMovers: padded(movers, MAX_MOVERS, empty),
      stFault: spec.fault ?? noFault(),
    },
  };
}

export interface CartesianSpec {
  pose?: Partial<ST_VisuPose>;
  originShift?: Partial<ST_VisuPosition>;
  zones?: ZoneSpec[];
  fingers?: ST_VisuFinger[];
  state?: Partial<Omit<ST_VisuCartesianState, "nTimestamp">>;
  timestamp?: bigint;
}

export function cartesian(spec: CartesianSpec = {}): ST_VisuCartesian {
  const zones = zoneList(spec);
  return {
    stConfig: {
      stPose: pose(spec.pose),
      fXMin: 0,
      fXMax: 1200,
      fYMin: 0,
      fYMax: 1000,
      fZMin: -600,
      fZMax: 0,
      fRailHeight: 1200,
      nZoneCount: zones.length,
      aZones: padded(zones, MAX_ZONES, emptyZone),
      ...fingerConfig(spec),
      ...originShift(spec),
    },
    stState: {
      nTimestamp: spec.timestamp ?? 0n,
      fX: 0,
      fY: 0,
      fZ: 0,
      bGripperActive: false,
      aFingerStates: fingerStates(),
      stFault: noFault(),
      ...spec.state,
    },
  };
}

/** A body; a box of 100 mm unless given otherwise. */
export function body(b: Partial<ST_VisuBody> = {}): ST_VisuBody {
  return {
    eShape: E_VisuBodyShape.BOX,
    eRole: E_VisuBodyRole.STRUCTURE,
    stPose: pose(),
    fLength: 100,
    fWidth: 100,
    fHeight: 100,
    fTopLength: 0,
    fTopWidth: 0,
    ...b,
  };
}

export function bodyStates(states: Partial<ST_VisuBodyState>[] = []): ST_VisuBodyState[] {
  return padded(
    states.map((s) => ({ bActive: false, ...s })),
    MAX_BODIES,
    () => ({ bActive: false }),
  );
}

export interface DetectorSpec {
  pose?: Partial<ST_VisuPose>;
  originShift?: Partial<ST_VisuPosition>;
  zones?: ZoneSpec[];
  bodies?: ST_VisuBody[];
  /** Body states; inactive unless given. */
  active?: boolean[];
  fault?: ST_VisuFault;
  timestamp?: bigint;
}

/** A vision system or product sensor: both share ST_VisuDetector. */
export function detector(spec: DetectorSpec = {}): ST_VisuDetector {
  const zones = zoneList(spec);
  const bodies = spec.bodies ?? [];
  return {
    stConfig: {
      stPose: pose(spec.pose),
      nZoneCount: zones.length,
      aZones: padded(zones, MAX_ZONES, emptyZone),
      nBodyCount: bodies.length,
      aBodies: padded(bodies, MAX_BODIES, () => body({ fLength: 0, fWidth: 0, fHeight: 0 })),
      ...originShift(spec),
    },
    stState: {
      nTimestamp: spec.timestamp ?? 0n,
      aBodyStates: bodyStates((spec.active ?? []).map((bActive) => ({ bActive }))),
      stFault: spec.fault ?? noFault(),
    },
  };
}

type Entry<K extends keyof typeof PLC_TYPES, V> = { id: number; name: string; path: string; kind: K; value: V };

export type MachineComponent =
  | Entry<"conveyor", ST_VisuConveyor>
  | Entry<"delta", ST_VisuDelta>
  | Entry<"xtsGantry", ST_VisuXtsGantry>
  | Entry<"xtsLoop", ST_VisuXtsLoop>
  | Entry<"cartesian", ST_VisuCartesian>
  | Entry<"vision", ST_VisuDetector>
  | Entry<"sensor", ST_VisuDetector>;

const MANIFEST_TYPES: Record<MachineComponent["kind"], number> = {
  conveyor: E_VisuComponentType.CONVEYOR,
  delta: E_VisuComponentType.DELTA,
  xtsGantry: E_VisuComponentType.XTS_GANTRY,
  xtsLoop: E_VisuComponentType.XTS_LOOP,
  cartesian: E_VisuComponentType.CARTESIAN,
  vision: E_VisuComponentType.VISION,
  sensor: E_VisuComponentType.SENSOR,
};

/** Registers a manifest and its components in an in-memory PLC. */
export function defineMachine(
  plc: InMemoryPlc,
  components: MachineComponent[],
  options: { protocolVersion?: number; configVersion?: number; manifestPath?: string } = {},
): void {
  const entries: ST_VisuManifestEntry[] = components.map((c) => ({
    nId: c.id,
    eType: MANIFEST_TYPES[c.kind],
    sName: c.name,
    sPath: c.path,
  }));
  const manifest: ST_VisuManifest = {
    nProtocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
    nConfigVersion: options.configVersion ?? 1,
    nCount: entries.length,
    aEntries: padded(entries, MAX_MANIFEST_ENTRIES, () => ({ nId: 0, eType: 0, sName: "", sPath: "" })),
  };
  plc.define(options.manifestPath ?? MANIFEST_PATH, PLC_TYPES.manifest, manifest);
  for (const c of components) plc.define(c.path, PLC_TYPES[c.kind], c.value);
}
