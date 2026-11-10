import { PROTOCOL_VERSION } from "@rpp/protocol";
import {
  E_VisuCartesianAxes,
  E_VisuProductShape,
  E_VisuBodyRole,
  E_VisuBodyShape,
  E_VisuModuleKind,
  E_VisuProductState,
  MANIFEST_PATH,
  PLC_MANIFEST_TYPE,
  type ST_VisuCartesian,
  type ST_VisuCartesianConfig,
  type ST_VisuCartesianState,
  type ST_VisuBody,
  type ST_VisuBodyState,
  type ST_VisuConveyor,
  type ST_VisuDetector,
  type ST_VisuStation,
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
  type ST_VisuTrackModule,
  type ST_VisuTrackModuleState,
  type ST_VisuGantryMover,
  type ST_VisuLoopMover,
  type ST_VisuXtsGantry,
  type ST_VisuXtsLoop,
  type ST_VisuLimitArea,
  type ST_VisuZone,
} from "./plc-contract";
import { COMPONENTS, type ComponentKind } from "./components";
import type { InMemoryPlc } from "./in-memory-plc";

/** Library defaults (constants in Syn_Visu, overridable per project). */
export const MAX_MANIFEST_ENTRIES = 32;
export const MAX_PRODUCTS = 4800;
export const MAX_PRODUCT_TYPES = 8;
export const MAX_ZONES = 8;
export const MAX_MOVERS = 40;
export const MAX_FINGERS = 8;
export const MAX_BODIES = 16;
export const MAX_MODULES = 64;
/** Length of an XTS motor module, straight or curve (VISU_f_XTS_MODULE_LENGTH). */
export const XTS_MODULE_LENGTH = 250;

export function trackModule(eKind: number = E_VisuModuleKind.STRAIGHT, fLength = XTS_MODULE_LENGTH): ST_VisuTrackModule {
  return { eKind, fLength };
}

function moduleConfig(modules: ST_VisuTrackModule[]) {
  return { nModuleCount: modules.length, aModules: padded(modules, MAX_MODULES, () => trackModule(0, 0)) };
}

/** A full module state array; module i has fault `faults[i]` if given. */
export function moduleStates(faults: (ST_VisuFault | undefined)[] = []): ST_VisuTrackModuleState[] {
  return padded(
    faults.map((f) => ({ stFault: f ?? noFault() })),
    MAX_MODULES,
    () => ({ stFault: noFault() }),
  );
}

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
    ePreviousState: E_VisuProductState.DETECTED,
    nLastClientId: 0,
    nMoverId: 0,
    nFingerId: 0,
    nProductType: 0,
  };
}

function emptyZone(): ST_VisuZone {
  return { nConveyorId: 0, fStart: 0, fEnd: 0, fAllocationOffset: 0, fCcsOffset: 0, fStartY: 0, fEndY: 0 };
}

/** A zone as tests and the simulator write it; the offsets and the Y bounds (whole belt width) default to 0. */
export type ZoneSpec = Omit<ST_VisuZone, "fAllocationOffset" | "fCcsOffset" | "fStartY" | "fEndY"> & {
  fAllocationOffset?: number;
  fCcsOffset?: number;
  fStartY?: number;
  fEndY?: number;
};

function zoneList(spec: { zones?: ZoneSpec[] }): ST_VisuZone[] {
  return (spec.zones ?? []).map((z) => ({ fAllocationOffset: 0, fCcsOffset: 0, fStartY: 0, fEndY: 0, ...z }));
}

/**
 * Limit area and TCP limit area of a Delta, an XTS gantry or a Cartesian robot (_FB_VisuRobot.m_SetLimitArea,
 * m_SetTcpLimitArea); each active only when given.
 */
export interface LimitAreaSpec {
  limitArea?: Omit<ST_VisuLimitArea, "bActive">;
  tcpLimitArea?: Omit<ST_VisuLimitArea, "bActive">;
}

function limitBox(box: Omit<ST_VisuLimitArea, "bActive"> | undefined): ST_VisuLimitArea {
  return box ? { ...box, bActive: true } : { fXMin: 0, fXMax: 0, fYMin: 0, fYMax: 0, fZMin: 0, fZMax: 0, bActive: false };
}

function limitArea(spec: LimitAreaSpec): { stLimitArea: ST_VisuLimitArea; stTcpLimitArea: ST_VisuLimitArea } {
  return { stLimitArea: limitBox(spec.limitArea), stTcpLimitArea: limitBox(spec.tcpLimitArea) };
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
  /** Drawn as a body; true when not given, like the library's default. */
  body?: boolean;
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
      bBody: spec.body ?? true,
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

export interface DeltaSpec extends LimitAreaSpec {
  pose?: Partial<ST_VisuPose>;
  originShift?: Partial<ST_VisuPosition>;
  baseRadius?: number;
  effectorRadius?: number;
  upperArmLength?: number;
  lowerArmLength?: number;
  fingers?: ST_VisuFinger[];
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
      ...limitArea(spec),
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

export interface XtsGantrySpec extends LimitAreaSpec {
  pose?: Partial<ST_VisuPose>;
  originShift?: Partial<ST_VisuPosition>;
  /** Three straight modules unless given. */
  modules?: ST_VisuTrackModule[];
  /** Per module, none unless given. */
  moduleFaults?: (ST_VisuFault | undefined)[];
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
      ...moduleConfig(spec.modules ?? [trackModule(), trackModule(), trackModule()]),
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
      ...limitArea(spec),
      ...fingerConfig(spec),
      ...originShift(spec),
    },
    stState: {
      nTimestamp: spec.timestamp ?? 0n,
      fZ: spec.z ?? 0,
      nMoverCount: movers.length,
      aMovers: padded(movers, MAX_MOVERS, empty),
      aModuleStates: moduleStates(spec.moduleFaults),
      stFault: spec.fault ?? noFault(),
    },
  };
}

export interface XtsLoopSpec {
  pose?: Partial<ST_VisuPose>;
  originShift?: Partial<ST_VisuPosition>;
  /** Eight straight modules, two left curves, eight straight, two left curves unless given. */
  modules?: ST_VisuTrackModule[];
  /** Per module, none unless given. */
  moduleFaults?: (ST_VisuFault | undefined)[];
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
      ...moduleConfig(spec.modules ?? loopModules(8)),
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
      aModuleStates: moduleStates(spec.moduleFaults),
      stFault: spec.fault ?? noFault(),
    },
  };
}

/** A loop of two straights of `straight` modules, each followed by two left curve modules. */
export function loopModules(straight: number): ST_VisuTrackModule[] {
  const half = [
    ...Array.from({ length: straight }, () => trackModule()),
    trackModule(E_VisuModuleKind.CURVE_LEFT),
    trackModule(E_VisuModuleKind.CURVE_LEFT),
  ];
  return [...half, ...half.map((m) => ({ ...m }))];
}

export interface CartesianSpec extends LimitAreaSpec {
  /** E_VisuCartesianAxes; XYZ when not given, like the library's default. */
  axes?: number;
  /** Axis limits; X 0..1200, Y 0..1000, Z −600..0 when not given. */
  strokes?: Partial<Pick<ST_VisuCartesianConfig, "fXMin" | "fXMax" | "fYMin" | "fYMax" | "fZMin" | "fZMax">>;
  railHeight?: number;
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
      eAxes: spec.axes ?? E_VisuCartesianAxes.XYZ,
      fXMin: 0,
      fXMax: 1200,
      fYMin: 0,
      fYMax: 1000,
      fZMin: -600,
      fZMax: 0,
      ...spec.strokes,
      fRailHeight: spec.railHeight ?? 1200,
      nZoneCount: zones.length,
      aZones: padded(zones, MAX_ZONES, emptyZone),
      ...limitArea(spec),
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

/** A station (reject unit, labeller, ...): bodies and zones like a detector, in its own ST_VisuStation. */
export function station(spec: DetectorSpec = {}): ST_VisuStation {
  return detector(spec);
}

/** The contract structure of every component type; the constraint makes the compiler ask for a new type's entry. */
type PlcStructures<T extends Record<ComponentKind, object> = {
  conveyor: ST_VisuConveyor;
  delta: ST_VisuDelta;
  xtsGantry: ST_VisuXtsGantry;
  xtsLoop: ST_VisuXtsLoop;
  cartesian: ST_VisuCartesian;
  vision: ST_VisuDetector;
  sensor: ST_VisuDetector;
  station: ST_VisuStation;
}> = T;

/** One component of a machine defined in an in-memory PLC: its manifest entry and its contract structure. */
export type MachineComponent = {
  [K in ComponentKind]: { id: number; name: string; path: string; kind: K; value: PlcStructures[K] };
}[ComponentKind];

/** Registers a manifest and its components in an in-memory PLC. */
export function defineMachine(
  plc: InMemoryPlc,
  components: MachineComponent[],
  options: { protocolVersion?: number; configVersion?: number; manifestPath?: string; libraryVersion?: string } = {},
): void {
  const entries: ST_VisuManifestEntry[] = components.map((c) => ({
    nId: c.id,
    eType: COMPONENTS[c.kind].plcValue,
    sName: c.name,
    sPath: c.path,
  }));
  const manifest: ST_VisuManifest = {
    nProtocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
    nConfigVersion: options.configVersion ?? 1,
    nCount: entries.length,
    aEntries: padded(entries, MAX_MANIFEST_ENTRIES, () => ({ nId: 0, eType: 0, sName: "", sPath: "" })),
    // Left out like a library older than 5.1 does.
    ...(options.libraryVersion !== undefined ? { sLibraryVersion: options.libraryVersion } : {}),
  };
  plc.define(options.manifestPath ?? MANIFEST_PATH, PLC_MANIFEST_TYPE, manifest);
  for (const c of components) plc.define(c.path, COMPONENTS[c.kind].plcType, c.value);
}
