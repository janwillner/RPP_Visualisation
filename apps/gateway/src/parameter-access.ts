import { z } from "zod";
import {
  CONFIG_PROTOCOL_VERSION,
  MIN_CONFIG_PROTOCOL_VERSION,
  PARAMETER_SCHEMAS,
  ParameterResultSchema,
  type ComponentParameters,
  type DiscoveryError,
  type ParametersMessage,
  type ParameterType,
  type ResetParametersCommand,
  type TypedParameters,
  type WriteParametersCommand,
} from "@rpp/protocol";
import { componentKind } from "./components";
import { PLC_CONFIG_MACHINE_TYPE, PLC_CONFIG_MANIFEST_TYPE, PLC_CONFIG_TYPES, type ST_ConfigManifest } from "./config-contract";
import { E_VisuComponentType, enumValue } from "./plc-contract";
import { mapPlc, type EntryMemory } from "./plc-mapping";
import { plcLeaves } from "./plc-writing";
import { machineFbEntry, machineParameters, machineReadPaths, type MachineFbEntry } from "./recipe-access";
import { SymbolNotFoundError, type SymbolAccess, type SymbolWrite } from "./symbol-access";

/**
 * One source's parameter sets (library Syn_Config, ADR 0017): which parameter FBs its config manifest lists, their
 * status and effective values as a `parameters` message, and the leaf values that stage a set or a reset.
 */

/** A parameter FB found in the config manifest. */
export interface ParameterEntry {
  /** Id of the Syn_Visu component it parametrises. */
  id: number;
  type: ParameterType;
  /** Symbol path of its `vo_Config`. */
  path: string;
  /** Its product types of the previous read: the cyclic read gives counted arrays as changes (ADR 0013). */
  memory: EntryMemory;
}

export interface ParameterDiscovery {
  /** The PLC has Syn_Config: a `parameters` message is published for it. */
  present: boolean;
  entries: ParameterEntry[];
  /** Why the source cannot be written; undefined when it can. */
  reason: string | undefined;
  /** Problems with single entries, reported with the source's discovery errors. */
  errors: DiscoveryError[];
  /** Config protocol of the PLC's Syn_Config; 0 without one. */
  protocolVersion: number;
  /** The application's machine FB with its recipe (config protocol 3 or later, ADR 0022), if it has one. */
  machine: MachineFbEntry | undefined;
}

/** Status of a parameter FB as the gateway reads it from `stStatus`. */
const StatusSchema = z.object({
  activeVersion: z.number().int(),
  handledStageId: z.number().int(),
  result: ParameterResultSchema,
  message: z.string(),
});

export const NOT_ALLOWED = "The gateway does not allow writing; start it with --allow-write.";

/** A source without parameter FBs that cannot be written, for `reason`; `present`: it has Syn_Config all the same. */
export function noParameters(reason: string, present = true): ParameterDiscovery {
  return { present, entries: [], reason, errors: [], protocolVersion: 0, machine: undefined };
}

/** Finds the parameter FBs; a source without a config manifest has none and cannot be written. */
export async function discoverParameters(
  plc: SymbolAccess,
  manifestPath: string,
  allowWrite: boolean,
): Promise<ParameterDiscovery> {
  const none = noParameters;
  const type = await plc.typeOf(manifestPath);
  if (type === undefined) {
    return none(`The PLC has no Syn_Config (${manifestPath} not found): its components cannot be written.`, false);
  }
  if (type !== PLC_CONFIG_MANIFEST_TYPE && !type.endsWith(`.${PLC_CONFIG_MANIFEST_TYPE}`)) {
    return none(`${manifestPath} is a ${type}, not Syn_Config's ${PLC_CONFIG_MANIFEST_TYPE}: nothing can be written.`);
  }
  const manifest = (await plc.read(manifestPath)) as ST_ConfigManifest;
  if (manifest.nProtocolVersion < MIN_CONFIG_PROTOCOL_VERSION || manifest.nProtocolVersion > CONFIG_PROTOCOL_VERSION) {
    return none(
      `The PLC's Syn_Config ${manifest.sLibraryVersion?.trim() || ""} has protocol version ${manifest.nProtocolVersion}, ` +
        `but this gateway expects ${MIN_CONFIG_PROTOCOL_VERSION} to ${CONFIG_PROTOCOL_VERSION}. Update the library or the gateway.`,
    );
  }
  const entries: ParameterEntry[] = [];
  const errors: DiscoveryError[] = [];
  let machine: MachineFbEntry | undefined;
  for (const e of manifest.aEntries.slice(0, manifest.nCount)) {
    // The machine FB: id 0, type NONE (config protocol 3 or later).
    if (e.nId === 0 && enumValue(e.eType) === E_VisuComponentType.NONE) {
      const actual = await plc.typeOf(e.sPath);
      if (actual !== PLC_CONFIG_MACHINE_TYPE && !actual?.endsWith(`.${PLC_CONFIG_MACHINE_TYPE}`)) {
        errors.push({ path: e.sPath, message: `Symbol has expected type ${PLC_CONFIG_MACHINE_TYPE} but is ${actual ?? "missing"}` });
        continue;
      }
      try {
        const read = machineFbEntry(e.sPath, await plc.read(e.sPath), manifest.nProtocolVersion);
        machine = read.entry;
        errors.push(...read.errors.map((message) => ({ path: e.sPath, message })));
      } catch (error) {
        // A layout the gateway does not know leaves the source without a recipe; connection errors propagate.
        if (!(error instanceof TypeError) && !(error instanceof SymbolNotFoundError)) throw error;
        errors.push({ path: e.sPath, message: `Cannot read the recipe fields: ${error.message}` });
      }
      continue;
    }
    const type = componentKind(enumValue(e.eType));
    if (type === undefined) {
      errors.push({ componentId: e.nId, path: e.sPath, message: `Unknown component type ${enumValue(e.eType)} in the config manifest` });
      continue;
    }
    const actual = await plc.typeOf(e.sPath);
    const expected = PLC_CONFIG_TYPES[type];
    if (actual !== expected && !actual?.endsWith(`.${expected}`)) {
      errors.push({ componentId: e.nId, path: e.sPath, message: `Symbol has expected type ${expected} but is ${actual ?? "missing"}` });
      continue;
    }
    entries.push({ id: e.nId, type, path: e.sPath, memory: new Map() });
  }
  return {
    present: true,
    entries,
    reason: allowWrite ? undefined : NOT_ALLOWED,
    errors,
    protocolVersion: manifest.nProtocolVersion,
    machine,
  };
}

/**
 * What the cyclic sum-read reads: of every parameter FB two paths, status and effective values; then of the machine FB
 * its recipe status, effective values and command answer.
 */
export function parameterReadPaths(d: ParameterDiscovery): string[] {
  return [...d.entries.flatMap((e) => [`${e.path}.stStatus`, `${e.path}.stActive`]), ...(d.machine ? machineReadPaths(d.machine) : [])];
}

/**
 * The `parameters` message from the values read at `parameterReadPaths`. A parameter FB of another layout (e.g. another
 * Syn_Config version) leaves the source read-only with the reason; it never stops the visualisation.
 */
export function parametersMessage(sourceId: string, d: ParameterDiscovery, raws: readonly unknown[]): ParametersMessage {
  let components: ComponentParameters[];
  let machine: ReturnType<typeof machineParameters> | undefined;
  try {
    components = d.entries.map((e, i): ComponentParameters => {
      const status = mapPlc(StatusSchema, raws[2 * i]);
      const parameters = mapPlc(PARAMETER_SCHEMAS[e.type], raws[2 * i + 1], {}, e.memory);
      return { id: e.id, ...status, set: { type: e.type, parameters } as TypedParameters };
    });
    if (d.machine) machine = machineParameters(d.machine, raws.slice(2 * d.entries.length));
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const reason = `Cannot read the parameter sets: ${error.message}. Does the gateway match the PLC's Syn_Config?`;
    return { kind: "parameters", sourceId, writable: false, reason, components: [] };
  }
  return {
    kind: "parameters",
    sourceId,
    writable: d.reason === undefined,
    ...(d.reason ? { reason: d.reason } : {}),
    components,
    ...machine,
  };
}

/**
 * Why a command cannot be carried out on the current status, or the leaf values that carry it out, in the order of one
 * sum-write: a waiting set withdrawn, the new set (for a write) and the staging, `bStaged` or `bReset` last, so the PLC
 * never sees a set staged half written.
 */
export function commandWrites(
  command: WriteParametersCommand | ResetParametersCommand,
  d: ParameterDiscovery,
  current: ParametersMessage | undefined,
  stageId: number,
): { error: string } | { writes: SymbolWrite[] } {
  if (d.reason !== undefined) return { error: d.reason };
  const entry = d.entries.find((e) => e.id === command.componentId);
  if (!entry) return { error: `Component ${command.componentId} has no parameter FB in the PLC's config manifest.` };
  const active = current?.components.find((c) => c.id === entry.id)?.activeVersion;
  if (active === undefined) return { error: `The parameter status of component ${entry.id} has not been read yet.` };
  if (active !== command.baseVersion) {
    return {
      error: `Component ${entry.id} has parameter version ${active} active, not ${command.baseVersion}: reconcile again before writing.`,
    };
  }
  const staging = `${entry.path}.stStaging`;
  const head: SymbolWrite[] = [
    { path: `${staging}.nBaseVersion`, value: command.baseVersion },
    { path: `${staging}.nStageId`, value: stageId },
  ];
  if (command.kind === "resetParameters") return { writes: [...head, { path: `${staging}.bReset`, value: true }] };
  if (command.set.type !== entry.type) {
    return { error: `Component ${entry.id} is a ${entry.type} in the PLC, not a ${command.set.type}.` };
  }
  const set = plcLeaves(PARAMETER_SCHEMAS[entry.type], command.set.parameters, `${entry.path}.stStaged`);
  // A set still waiting to be allowed is withdrawn first, so it is never taken over half overwritten.
  const withdraw: SymbolWrite = { path: `${staging}.bStaged`, value: false };
  return {
    writes: [withdraw, ...set, ...head, { path: `${staging}.bReset`, value: false }, { path: `${staging}.bStaged`, value: true }],
  };
}

