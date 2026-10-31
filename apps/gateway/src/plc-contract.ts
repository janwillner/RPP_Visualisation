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
} as const;

/** E_VisuComponentType */
export const E_VisuComponentType = { NONE: 0, CONVEYOR: 1, DELTA: 2, XTS_GANTRY: 3, XTS_LOOP: 4, CARTESIAN: 5 } as const;

/** E_VisuProductState */
export const E_VisuProductState = { DETECTED: 0, ASSIGNED: 1, PICKED: 2, REJECTED: 3, PLACED: 4 } as const;

/** E_VisuZoneKind */
export const E_VisuZoneKind = { PICK: 1, PLACE: 2 } as const;

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
}

export interface ST_VisuProductType {
  nId: number;
  fLength: number;
  fWidth: number;
  fHeight: number;
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
  stLatchPose: ST_VisuPlanarPose;
  fLatchBeltPosition: number;
  eState: PlcEnum;
  nRobotId: number;
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
  eKind: PlcEnum;
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

export interface ST_VisuXtsGantryConfig {
  stPose: ST_VisuPose;
  nModuleCount: number;
  fModuleLength: number;
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
  stFault: ST_VisuFault;
}

export interface ST_VisuXtsGantry {
  stConfig: ST_VisuXtsGantryConfig;
  stState: ST_VisuXtsGantryState;
}

export interface ST_VisuXtsLoopConfig {
  stPose: ST_VisuPose;
  fStraightLength: number;
  fCurveRadius: number;
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

export function enumValue(value: PlcEnum): number {
  return typeof value === "number" ? value : value.value;
}
