/**
 * Shapes of the PLC-side interface structures (library Syn_Visu) as a symbol reader returns them:
 * structs as objects keyed by member name, arrays as JS arrays, ULINT as bigint.
 *
 * Member names follow the Beckhoff Hungarian naming convention used in the PLC library.
 */

/** Fixed symbol where discovery starts. */
export const MANIFEST_PATH = "GVL_Visu.stManifest";

/** Expected PLC data type names, checked against the symbol table during discovery. */
export const PLC_TYPES = {
  manifest: "ST_VisuManifest",
  conveyor: "ST_VisuConveyor",
  delta: "ST_VisuDelta",
} as const;

/** E_VisuComponentType */
export const E_VisuComponentType = { NONE: 0, CONVEYOR: 1, DELTA: 2 } as const;

/** E_VisuProductState */
export const E_VisuProductState = { DETECTED: 0, ASSIGNED: 1, PICKED: 2, REJECTED: 3, PLACED: 4 } as const;

/** E_VisuWindowKind */
export const E_VisuWindowKind = { PICK: 1, PLACE: 2 } as const;

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
}

export interface ST_VisuProduct {
  nId: number;
  bValid: boolean;
  stLatchPose: ST_VisuPlanarPose;
  fLatchEncoder: number;
  eState: PlcEnum;
  nRobotId: number;
  nProductType: number;
}

export interface ST_VisuConveyorState {
  nTimestamp: bigint;
  fEncoder: number;
  nProductCount: number;
  aProducts: ST_VisuProduct[];
}

export interface ST_VisuConveyor {
  stConfig: ST_VisuConveyorConfig;
  stState: ST_VisuConveyorState;
}

export interface ST_VisuDeltaAxisConfig {
  fAngleOffset: number;
  nDirection: number;
}

export interface ST_VisuWorkArea {
  fRadius: number;
  fZMin: number;
  fZMax: number;
  fConeHeight: number;
  fConeBottomRadius: number;
}

export interface ST_VisuWindow {
  nConveyorId: number;
  fStart: number;
  fEnd: number;
  eKind: PlcEnum;
}

export interface ST_VisuDeltaConfig {
  stPose: ST_VisuPose;
  fBaseRadius: number;
  fEffectorRadius: number;
  fUpperArmLength: number;
  fLowerArmLength: number;
  bHasRotationAxis: boolean;
  /** Four entries; the fourth is used only with bHasRotationAxis. */
  aAxes: ST_VisuDeltaAxisConfig[];
  stWorkArea: ST_VisuWorkArea;
  nWindowCount: number;
  aWindows: ST_VisuWindow[];
}

export interface ST_VisuDeltaState {
  nTimestamp: bigint;
  /** Four entries; the fourth is used only with bHasRotationAxis. */
  aAxisPositions: number[];
  stActualTcp: ST_VisuPlanarPose;
  stSetpointTcp: ST_VisuPlanarPose;
}

export interface ST_VisuDelta {
  stConfig: ST_VisuDeltaConfig;
  stState: ST_VisuDeltaState;
}

export function enumValue(value: PlcEnum): number {
  return typeof value === "number" ? value : value.value;
}
