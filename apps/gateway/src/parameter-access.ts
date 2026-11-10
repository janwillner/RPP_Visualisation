import { z } from "zod";
import {
  CONFIG_PROTOCOL_VERSION,
  PARAMETER_SCHEMAS,
  ParameterResultSchema,
  type ClientMessage,
  type ComponentParameters,
  type DiscoveryError,
  type ParametersMessage,
  type ParameterType,
  type TypedParameters,
} from "@rpp/protocol";
import { componentKind } from "./components";
import { PLC_CONFIG_TYPES, type ST_ConfigManifest } from "./config-contract";
import { enumValue } from "./plc-contract";
import { mapPlc, type EntryMemory } from "./plc-mapping";
import { plcLeaves } from "./plc-writing";
import type { SymbolAccess, SymbolWrite } from "./symbol-access";

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
}

/** Status of a parameter FB as the gateway reads it from `stStatus`. */
const StatusSchema = z.object({
  activeVersion: z.number().int(),
  handledStageId: z.number().int(),
  result: ParameterResultSchema,
  message: z.string(),
});

export const NOT_ALLOWED = "The gateway does not allow writing; start it with --allow-write.";

/** Finds the parameter FBs; a source without a config manifest has none and cannot be written. */
export async function discoverParameters(
  plc: SymbolAccess,
  manifestPath: string,
  allowWrite: boolean,
): Promise<ParameterDiscovery> {
  const none = (reason: string, present = true): ParameterDiscovery => ({ present, entries: [], reason, errors: [] });
  if ((await plc.typeOf(manifestPath)) === undefined) {
    return none(`The PLC has no Syn_Config (${manifestPath} not found): its components cannot be written.`, false);
  }
  const manifest = (await plc.read(manifestPath)) as ST_ConfigManifest;
  if (manifest.nProtocolVersion !== CONFIG_PROTOCOL_VERSION) {
    return none(
      `The PLC's Syn_Config ${manifest.sLibraryVersion?.trim() || ""} has protocol version ${manifest.nProtocolVersion}, ` +
        `but this gateway expects ${CONFIG_PROTOCOL_VERSION}. Update the library or the gateway.`,
    );
  }
  const entries: ParameterEntry[] = [];
  const errors: DiscoveryError[] = [];
  for (const e of manifest.aEntries.slice(0, manifest.nCount)) {
    const type = componentKind(enumValue(e.eType));
    if (type !== "conveyor" && type !== "delta") {
      errors.push({ componentId: e.nId, path: e.sPath, message: `Syn_Config has no parameter set for this type yet` });
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
  return { present: true, entries, reason: allowWrite ? undefined : NOT_ALLOWED, errors };
}

/** What the cyclic sum-read reads of every parameter FB, two paths each: status and effective values. */
export function parameterReadPaths(d: ParameterDiscovery): string[] {
  return d.entries.flatMap((e) => [`${e.path}.stStatus`, `${e.path}.stActive`]);
}

/** The `parameters` message from the values read at `parameterReadPaths`. */
export function parametersMessage(sourceId: string, d: ParameterDiscovery, raws: readonly unknown[]): ParametersMessage {
  const components = d.entries.map((e, i): ComponentParameters => {
    const status = mapPlc(StatusSchema, raws[2 * i]);
    const parameters = mapPlc(PARAMETER_SCHEMAS[e.type], raws[2 * i + 1], {}, e.memory);
    return { id: e.id, ...status, set: { type: e.type, parameters } as TypedParameters };
  });
  return { kind: "parameters", sourceId, writable: d.reason === undefined, ...(d.reason ? { reason: d.reason } : {}), components };
}

/**
 * Why a command cannot be carried out on the current status, or the leaf values that carry it out, in the order of one
 * sum-write: a waiting set withdrawn, the new set (for a write) and the staging, `bStaged` or `bReset` last, so the PLC
 * never sees a set staged half written.
 */
export function commandWrites(
  command: ClientMessage,
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

