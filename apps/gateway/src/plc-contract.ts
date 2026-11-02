/**
 * Shapes of the PLC-side interface structures (library Syn_Visu) as a symbol reader returns them:
 * structs as objects keyed by member name, arrays as JS arrays, ULINT as bigint.
 *
 * Member names follow the Beckhoff Hungarian naming convention used in the PLC library.
 */

/** Fixed symbol where discovery starts. */
/** Default symbol path of the manifest; overridable per gateway (`manifestPath`) when the application names its GVL differently. */
export const MANIFEST_PATH = "GVL_Visu.stManifest";

/** Expected PLC data type names, checked against the symbol table during discovery. */
export const PLC_TYPES = {
  manifest: "ST_VisuManifest",
  conveyor: "ST_VisuConveyor",
  delta: "ST_VisuDelta",
  xtsGantry: "ST_VisuXtsGantry",
  xtsLoop: "ST_VisuXtsLoop",
  cartesian: "ST_VisuCartesian",
  vision: "ST_VisuDetector",
  sensor: "ST_VisuDetector",
  station: "ST_VisuStation",
} as const;

/** E_VisuComponentType */
export const E_VisuComponentType = {
  NONE: 0,
  CONVEYOR: 1,
  DELTA: 2,
  XTS_GANTRY: 3,
  XTS_LOOP: 4,
  CARTESIAN: 5,
  VISION: 6,
  SENSOR: 7,
  STATION: 8,
} as const;

/** E_VisuProductState */
export const E_VisuProductState = { DETECTED: 0, ASSIGNED: 1, PICKED: 2, REJECTED: 3, PLACED: 4 } as const;

/** E_VisuBodyShape */
export const E_VisuBodyShape = { BOX: 0, CYLINDER: 1, FRUSTUM: 2 } as const;

/** E_VisuBodyRole */
export const E_VisuBodyRole = { STRUCTURE: 0, SENSOR: 1, BEAM: 2, FIELD_OF_VIEW: 3 } as const;

/** E_VisuModuleKind: a curve module turns by a quarter circle. */
export const E_VisuModuleKind = { STRAIGHT: 0, CURVE_LEFT: 1, CURVE_RIGHT: 2 } as const;

/** E_VisuProductShape */
export const E_VisuProductShape = { BOX: 0, CYLINDER: 1, ROUNDED_BOX: 2 } as const;

/** Enums are numbers, or `{ name, value }` objects when the ADS client objectifies enumerations. */
export type PlcEnum = number | { name: string; value: number };

export interface ST_VisuPose {
  fX: number;
  fY: number;
  fZ: number;
  fRx: number;
  fRy: number;
  fRz: number;
}

export interface ST_VisuPosition {
  fX: number;
  fY: number;
  fZ: number;
}

export interface ST_VisuFinger {
  fDiameter: number;
  fHeight: number;
}

export interface ST_VisuFingerState {
  /** Pose of the finger's frame (centre of its top face), absolute in the MCS. */
  stPose: ST_VisuPose;
  bActive: boolean;
}

/** Fault of a component or a mover; set by the PLC, cleared when bActive is FALSE. */
export interface ST_VisuFault {
  bActive: boolean;
  /** STRING(80) */
  sMessage: string;
}

export interface ST_VisuPlanarPose {
  fX: number;
  fY: number;
  fZ: number;
  fRz: number;
}

export interface ST_VisuManifestEntry {
  nId: number;
  eType: PlcEnum;
  sName: string;
  sPath: string;
}

export interface ST_VisuManifest {
  nProtocolVersion: number;
  nConfigVersion: number;
  nCount: number;
  aEntries: ST_VisuManifestEntry[];
  /** Version of the Syn_Visu library the PLC runs, e.g. "5.1.0"; missing before library 5.1. */
  sLibraryVersion?: string;
}

export interface ST_VisuProductType {
  nId: number;
  fLength: number;
  fWidth: number;
  fHeight: number;
  eShape: PlcEnum;
  /** mm, rounded vertical edges of a ROUNDED_BOX. */
  fCornerRadius: number;
}

export interface ST_VisuConveyorConfig {
  stPose: ST_VisuPose;
  fLength: number;
  fWidth: number;
  nProductTypeCount: number;
  aProductTypes: ST_VisuProductType[];
  /** mm in the local frame from stPose; belt coordinates count from here. */
  stOriginShift: ST_VisuPosition;
}

export interface ST_VisuProduct {
  nId: number;
  bValid: boolean;
  /** Bottom centre at the latch, in the conveyor's coordinate system (from stPose + stOriginShift). */
  stLatchPose: ST_VisuPlanarPose;
  fLatchBeltPosition: number;
  eState: PlcEnum;
  /** E_VisuProductState before the last change. */
  ePreviousState: PlcEnum;
  /** Manifest id of the client (robot, detector, station) that made the last change; 0 = none given. */
  nLastClientId: number;
  nMoverId: number;
  nFingerId: number;
  nProductType: number;
}

export interface ST_VisuConveyorState {
  nTimestamp: bigint;
  fBeltPosition: number;
  nProductCount: number;
  aProducts: ST_VisuProduct[];
  stFault: ST_VisuFault;
}

export interface ST_VisuConveyor {
  stConfig: ST_VisuConveyorConfig;
  stState: ST_VisuConveyorState;
}

export interface ST_VisuWorkingArea {
  fRadius: number;
  fZMin: number;
  fZMax: number;
  fConeHeight: number;
  fConeBottomRadius: number;
}

export interface ST_VisuLimitArea {
  fXMin: number;
  fXMax: number;
  fYMin: number;
  fYMax: number;
  fZMin: number;
  fZMax: number;
  bActive: boolean;
}

export interface ST_VisuZone {
  nConveyorId: number;
  fStart: number;
  fEnd: number;
  fAllocationOffset: number;
  /** mm along the conveyor's local X: the robot's conveyor coordinate system. */
  fCcsOffset: number;
}

export interface ST_VisuDeltaConfig {
  stPose: ST_VisuPose;
  fBaseRadius: number;
  fEffectorRadius: number;
  fUpperArmLength: number;
  fLowerArmLength: number;
  stWorkingArea: ST_VisuWorkingArea;
  stLimitArea: ST_VisuLimitArea;
  nZoneCount: number;
  aZones: ST_VisuZone[];
  nFingerCount: number;
  aFingers: ST_VisuFinger[];
  /** mm in the local frame from stPose; only where the origin is shown. */
  stOriginShift: ST_VisuPosition;
}

export interface ST_VisuDeltaState {
  nTimestamp: bigint;
  /** Actual TCP (effector centre) in the MCS; the visualisation derives the arms from it. */
  stActualTcp: ST_VisuPosition;
  stSetpointTcp: ST_VisuPosition;
  aFingerStates: ST_VisuFingerState[];
  stFault: ST_VisuFault;
}

export interface ST_VisuDelta {
  stConfig: ST_VisuDeltaConfig;
  stState: ST_VisuDeltaState;
}

/** One XTS motor module of a track. */
export interface ST_VisuTrackModule {
  eKind: PlcEnum;
  /** mm along the track. */
  fLength: number;
}

/** Live state of a track module. */
export interface ST_VisuTrackModuleState {
  stFault: ST_VisuFault;
}

export interface ST_VisuXtsGantryConfig {
  stPose: ST_VisuPose;
  nModuleCount: number;
  aModules: ST_VisuTrackModule[];
  fXMin: number;
  fXMax: number;
  fZMin: number;
  fZMax: number;
  fToolOffsetX: number;
  fToolOffsetZ: number;
  fMoverLength: number;
  fMoverWidth: number;
  nZoneCount: number;
  aZones: ST_VisuZone[];
  nFingerCount: number;
  aFingers: ST_VisuFinger[];
  /** mm in the local frame from stPose; only where the origin is shown. */
  stOriginShift: ST_VisuPosition;
}

export interface ST_VisuGantryMover {
  nId: number;
  bValid: boolean;
  fPosition: number;
  fX: number;
  bGripperActive: boolean;
  aFingerStates: ST_VisuFingerState[];
  stFault: ST_VisuFault;
}

export interface ST_VisuXtsGantryState {
  nTimestamp: bigint;
  fZ: number;
  nMoverCount: number;
  aMovers: ST_VisuGantryMover[];
  /** One per possible track module, index as in aModules. */
  aModuleStates: ST_VisuTrackModuleState[];
  stFault: ST_VisuFault;
}

export interface ST_VisuXtsGantry {
  stConfig: ST_VisuXtsGantryConfig;
  stState: ST_VisuXtsGantryState;
}

export interface ST_VisuXtsLoopConfig {
  stPose: ST_VisuPose;
  nModuleCount: number;
  aModules: ST_VisuTrackModule[];
  fToolOffset: number;
  fMoverLength: number;
  fMoverWidth: number;
  nZoneCount: number;
  aZones: ST_VisuZone[];
  nFingerCount: number;
  aFingers: ST_VisuFinger[];
  /** mm in the local frame from stPose; only where the origin is shown. */
  stOriginShift: ST_VisuPosition;
}

export interface ST_VisuLoopMover {
  nId: number;
  bValid: boolean;
  fPosition: number;
  aFingerStates: ST_VisuFingerState[];
  stFault: ST_VisuFault;
}

export interface ST_VisuXtsLoopState {
  nTimestamp: bigint;
  nMoverCount: number;
  aMovers: ST_VisuLoopMover[];
  /** One per possible track module, index as in aModules. */
  aModuleStates: ST_VisuTrackModuleState[];
  stFault: ST_VisuFault;
}

export interface ST_VisuXtsLoop {
  stConfig: ST_VisuXtsLoopConfig;
  stState: ST_VisuXtsLoopState;
}

export interface ST_VisuCartesianConfig {
  stPose: ST_VisuPose;
  fXMin: number;
  fXMax: number;
  fYMin: number;
  fYMax: number;
  fZMin: number;
  fZMax: number;
  fRailHeight: number;
  nZoneCount: number;
  aZones: ST_VisuZone[];
  nFingerCount: number;
  aFingers: ST_VisuFinger[];
  /** mm in the local frame from stPose; only where the origin is shown. */
  stOriginShift: ST_VisuPosition;
}

export interface ST_VisuCartesianState {
  nTimestamp: bigint;
  fX: number;
  fY: number;
  fZ: number;
  bGripperActive: boolean;
  aFingerStates: ST_VisuFingerState[];
  stFault: ST_VisuFault;
}

export interface ST_VisuCartesian {
  stConfig: ST_VisuCartesianConfig;
  stState: ST_VisuCartesianState;
}

/** One solid of a detector: bottom centre at stPose in the component's frame, extending along its local +Z. */
export interface ST_VisuBody {
  eShape: PlcEnum;
  eRole: PlcEnum;
  stPose: ST_VisuPose;
  fLength: number;
  fWidth: number;
  fHeight: number;
  /** Top face of a FRUSTUM. */
  fTopLength: number;
  fTopWidth: number;
}

export interface ST_VisuBodyState {
  bActive: boolean;
}

/** Vision system and product sensor share one contract structure; the manifest type tells them apart. */
export interface ST_VisuDetectorConfig {
  stPose: ST_VisuPose;
  nZoneCount: number;
  aZones: ST_VisuZone[];
  nBodyCount: number;
  aBodies: ST_VisuBody[];
  stOriginShift: ST_VisuPosition;
}

export interface ST_VisuDetectorState {
  nTimestamp: bigint;
  aBodyStates: ST_VisuBodyState[];
  stFault: ST_VisuFault;
}

export interface ST_VisuDetector {
  stConfig: ST_VisuDetectorConfig;
  stState: ST_VisuDetectorState;
}

/** A station has its own contract structure, with the same members as a detector's. */
export interface ST_VisuStationConfig {
  stPose: ST_VisuPose;
  nZoneCount: number;
  aZones: ST_VisuZone[];
  nBodyCount: number;
  aBodies: ST_VisuBody[];
  stOriginShift: ST_VisuPosition;
}

export interface ST_VisuStationState {
  nTimestamp: bigint;
  aBodyStates: ST_VisuBodyState[];
  stFault: ST_VisuFault;
}

export interface ST_VisuStation {
  stConfig: ST_VisuStationConfig;
  stState: ST_VisuStationState;
}

export function enumValue(value: PlcEnum): number {
  return typeof value === "number" ? value : value.value;
}
