import type { ParameterType } from "@rpp/protocol";
import type {
  PlcEnum,
  ST_VisuFinger,
  ST_VisuLimitArea,
  ST_VisuPose,
  ST_VisuPosition,
  ST_VisuProductType,
  ST_VisuTrackModule,
  ST_VisuWorkingArea,
  ST_VisuZone,
} from "./plc-contract";

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

/** E_ConfigFieldType: how a recipe field's value is kept (config protocol 3); the protocol's `RecipeFieldType` by index. */
export const E_ConfigFieldType = { NUMBER: 0, INTEGER: 1, SWITCH: 2, CHOICE: 3 } as const;

/** E_ConfigCommand: what a machine command asks (config protocol 3). */
export const E_ConfigCommand = { NONE: 0, START: 1, STOP: 2, RESET: 3 } as const;

/** E_ConfigCommandResult: what the application made of the last machine command. */
export const E_ConfigCommandResult = { NONE: 0, ACCEPTED: 1, REJECTED: 2 } as const;

/** PLC data type of the machine FB's `vo_Config` (`_FB_ConfigMachine`, config protocol 3, ADR 0022). */
export const PLC_CONFIG_MACHINE_TYPE = "ST_ConfigMachine";

/** Library defaults of Syn_Config (`CONFIG_GlobalConst_Param`). */
export const MAX_RECIPE_FIELDS = 64;
export const MAX_CHOICES = 8;

/** One recipe field as the application declares it with `_FB_ConfigMachine.m_DeclareField`. */
export interface ST_ConfigRecipeField {
  /** STRING(31), unique in the recipe. */
  sName: string;
  /** Manifest id of the Syn_Visu component it belongs to; 0 = the whole machine. */
  nGroup: number;
  /** E_ConfigFieldType */
  eType: PlcEnum;
  /** STRING(15) */
  sUnit: string;
  fMin: number;
  fMax: number;
  fProgramValue: number;
  nChoiceCount: number;
  /** STRING(31) each: the names of a choice field's values, from value 0. */
  aChoices: string[];
  /** STRING(40), config protocol 4 (`m_SetText`): the field's label; empty = its name put into words. */
  sLabel?: string;
  /** STRING(160), config protocol 4: what the field is for. */
  sDescription?: string;
  /** Config protocol 4 (`m_SetVisibleWhen`): the field (from 1) it applies only with; 0 = always. */
  nVisibleField?: number;
  /** Config protocol 4: the value `nVisibleField` must have. */
  nVisibleValue?: number;
}

/** Written by the gateway, `bRequested` last; the machine FB clears it once the application answered. */
export interface ST_ConfigCommand {
  nCommandId: number;
  /** E_ConfigCommand */
  eCommand: PlcEnum;
  bRequested: boolean;
}

export interface ST_ConfigCommandStatus {
  nHandledCommandId: number;
  /** E_ConfigCommandResult */
  eResult: PlcEnum;
  /** STRING(80): why the application rejected it. */
  sMessage: string;
}

/**
 * `vo_Config` of the machine FB, listed in the config manifest with id 0 and type NONE: the recipe's declared fields
 * (read at discovery), its staging (written, values by field index, a value of every type as LREAL), its status and
 * effective values (read every cycle), the machine command (written) and its answer (read every cycle).
 */
export interface ST_ConfigMachine {
  nFieldCount: number;
  aFields: ST_ConfigRecipeField[];
  stStaging: ST_ConfigStaging;
  aStaged: number[];
  stStatus: ST_ConfigStatus;
  aActive: number[];
  stCommand: ST_ConfigCommand;
  stCommandStatus: ST_ConfigCommandStatus;
}

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
  nFingerCount: number;
  aFingers: ST_VisuFinger[];
  stWorkingArea: ST_VisuWorkingArea;
  stLimitArea: ST_VisuLimitArea;
  stTcpLimitArea: ST_VisuLimitArea;
}

export interface ST_ConfigXtsGantryParam {
  stPose: ST_VisuPose;
  stOriginShift: ST_VisuPosition;
  nModuleCount: number;
  aModules: ST_VisuTrackModule[];
  nZoneCount: number;
  aZones: ST_VisuZone[];
  nFingerCount: number;
  aFingers: ST_VisuFinger[];
  stLimitArea: ST_VisuLimitArea;
  stTcpLimitArea: ST_VisuLimitArea;
}

export interface ST_ConfigXtsLoopParam {
  stPose: ST_VisuPose;
  stOriginShift: ST_VisuPosition;
  nModuleCount: number;
  aModules: ST_VisuTrackModule[];
  nZoneCount: number;
  aZones: ST_VisuZone[];
  nFingerCount: number;
  aFingers: ST_VisuFinger[];
}

export interface ST_ConfigCartesianParam {
  stPose: ST_VisuPose;
  stOriginShift: ST_VisuPosition;
  nZoneCount: number;
  aZones: ST_VisuZone[];
  nFingerCount: number;
  aFingers: ST_VisuFinger[];
  stLimitArea: ST_VisuLimitArea;
  stTcpLimitArea: ST_VisuLimitArea;
}

/** Vision system, product sensor and station share it: their bodies are hardware, so only these remain. */
export interface ST_ConfigBodyComponentParam {
  stPose: ST_VisuPose;
  stOriginShift: ST_VisuPosition;
  nZoneCount: number;
  aZones: ST_VisuZone[];
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
export const PLC_CONFIG_TYPES = {
  conveyor: "ST_ConfigConveyor",
  delta: "ST_ConfigDelta",
  xtsGantry: "ST_ConfigXtsGantry",
  xtsLoop: "ST_ConfigXtsLoop",
  cartesian: "ST_ConfigCartesian",
  vision: "ST_ConfigBodyComponent",
  sensor: "ST_ConfigBodyComponent",
  station: "ST_ConfigBodyComponent",
} as const satisfies Record<ParameterType, string>;
