import type { PlcEnum, ST_VisuLimitArea, ST_VisuPose, ST_VisuPosition, ST_VisuProductType, ST_VisuWorkingArea, ST_VisuZone } from "./plc-contract";

/**
 * Shapes of the PLC-side structures of the library Syn_Config (ADR 0017), as a symbol reader returns them. The
 * parameter structures follow the naming convention of `plc-mapping.ts`, so they are read and written without code per
 * component: a member is the protocol field with its Hungarian prefix, an array has a count member.
 *
 * Arrays are indexed from 0 here, as in every value read; an adapter maps an index to the PLC array's lower bound.
 */

/** Default symbol path of the config manifest; overridable per gateway (`configManifestPath`). */
export const CONFIG_MANIFEST_PATH = "GVL_Config.stManifest";

/** PLC data type of the config manifest, checked during discovery. */
export const PLC_CONFIG_MANIFEST_TYPE = "ST_ConfigManifest";

/** E_ConfigResult: what became of the last staged set. */
export const E_ConfigResult = { NONE: 0, PENDING: 1, APPLIED: 2, REJECTED: 3 } as const;

export interface ST_ConfigManifestEntry {
  /** Id of the Syn_Visu component the parameter FB is for. */
  nId: number;
  /** E_VisuComponentType of that component. */
  eType: PlcEnum;
  /** Symbol path of the parameter FB's `vo_Config`. */
  sPath: string;
}

export interface ST_ConfigManifest {
  nProtocolVersion: number;
  /** STRING(20), e.g. '1.0.0'. */
  sLibraryVersion: string;
  nCount: number;
  aEntries: ST_ConfigManifestEntry[];
}

/** Written by the gateway, `bStaged` (or `bReset`) last in the same sum-write. */
export interface ST_ConfigStaging {
  /** The active version the staged set is based on. */
  nBaseVersion: number;
  /** Chosen by the gateway; echoed in `ST_ConfigStatus.nHandledStageId` once handled. */
  nStageId: number;
  /** TRUE: make the active set invalid instead of taking over `stStaged`. */
  bReset: boolean;
  /** TRUE: `stStaged` is complete and waits to be taken over; the FB clears it when it handled it. */
  bStaged: boolean;
}

export interface ST_ConfigStatus {
  /** 0 while the program values apply. */
  nActiveVersion: number;
  nHandledStageId: number;
  /** E_ConfigResult */
  eResult: PlcEnum;
  /** STRING(80): why the last staged set was rejected. */
  sMessage: string;
}

export interface ST_ConfigConveyorParam {
  stPose: ST_VisuPose;
  stOriginShift: ST_VisuPosition;
  nProductTypeCount: number;
  aProductTypes: ST_VisuProductType[];
}

export interface ST_ConfigDeltaParam {
  stPose: ST_VisuPose;
  stOriginShift: ST_VisuPosition;
  nZoneCount: number;
  aZones: ST_VisuZone[];
  stWorkingArea: ST_VisuWorkingArea;
  stLimitArea: ST_VisuLimitArea;
  stTcpLimitArea: ST_VisuLimitArea;
}

/** `vo_Config` of a parameter FB: what the gateway writes (staging) and reads (status, active values). */
export interface ST_ConfigComponent<P> {
  stStaging: ST_ConfigStaging;
  stStaged: P;
  stStatus: ST_ConfigStatus;
  /** The effective values: the active set while one is valid, else the application's program values. */
  stActive: P;
}

export type ST_ConfigConveyor = ST_ConfigComponent<ST_ConfigConveyorParam>;
export type ST_ConfigDelta = ST_ConfigComponent<ST_ConfigDeltaParam>;

/** The PLC type of each parameter FB's `vo_Config`, by protocol component type. */
export const PLC_CONFIG_TYPES = { conveyor: "ST_ConfigConveyor", delta: "ST_ConfigDelta" } as const;
