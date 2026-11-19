import type { PlcEnum } from "./plc-contract";

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

/** PLC data type of the topology FB's `vo_Config` (`_FB_ConfigTopology`, config protocol 5, ADR 0023). */
export const PLC_CONFIG_TOPOLOGY_TYPE = "ST_ConfigTopology";

/** Library defaults of Syn_Config for the topology (`CONFIG_GlobalConst_Param`). */
export const MAX_TOPOLOGY_KINDS = 16;
export const MAX_TOPOLOGY_ROLES = 16;
export const MAX_TOPOLOGY_NODES = 64;
export const MAX_TOPOLOGY_LINKS = 128;
export const MAX_NODE_COMPONENTS = 4;

/** A kind of topology node (`_FB_ConfigTopology.m_DeclareKind`), referred to by its number from 1. */
export interface ST_ConfigTopologyKind {
  /** STRING(31), unique in the topology. */
  sName: string;
  /** DWORD: bit k - 1 set = kind k may be the parent of a node of this kind (`m_AllowParent`). */
  nParentKinds: number;
}

/** A role a link may have (`m_DeclareRole`), referred to by its number from 1; 0 is the parent. */
export interface ST_ConfigTopologyRole {
  /** STRING(31), unique in the topology. */
  sName: string;
  /** The kind (from 1) of node that holds the role. */
  nHolderKind: number;
  /** DWORD: bit k - 1 set = a link in this role may point to a node of kind k (`m_AllowTarget`). */
  nTargetKinds: number;
  bRequired: boolean;
}

/** A topology node (`m_DeclareNode`, `m_AddComponent`). */
export interface ST_ConfigTopologyNode {
  /** DINT: the application's id, unique in the topology. */
  nId: number;
  /** STRING(31) */
  sName: string;
  /** The node's kind, from 1. */
  nKind: number;
  nComponentCount: number;
  /** UDINT each: manifest ids of the Syn_Visu components the node stands for. */
  aComponents: number[];
}

/** One link: node `nNode` points to `nTarget` in role `nRole` (0 = its parent). */
export interface ST_ConfigTopologyLink {
  nNode: number;
  nRole: number;
  nTarget: number;
}

/** A set of links: the parents and the links of every role. */
export interface ST_ConfigTopologyLinks {
  nLinkCount: number;
  aLinks: ST_ConfigTopologyLink[];
}

/**
 * `vo_Config` of the topology FB, listed in the config manifest with id 0 and type NONE like the machine FB: the
 * declaration (read at discovery) and the links in effect (read every cycle).
 */
export interface ST_ConfigTopology {
  nKindCount: number;
  aKinds: ST_ConfigTopologyKind[];
  nRoleCount: number;
  aRoles: ST_ConfigTopologyRole[];
  nNodeCount: number;
  aNodes: ST_ConfigTopologyNode[];
  /** DINT: id of the root node, 0 = none declared. */
  nRootNode: number;
  /** The links in effect: the application's program values. */
  stActive: ST_ConfigTopologyLinks;
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

/** `vo_Config` of a parameter FB: what the gateway writes (staging) and reads (status, active values). */
export interface ST_ConfigComponent<P> {
  stStaging: ST_ConfigStaging;
  stStaged: P;
  stStatus: ST_ConfigStatus;
  /** The effective values: the active set while one is valid, else the application's program values. */
  stActive: P;
}

