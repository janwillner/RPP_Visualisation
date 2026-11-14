import {
  CONFIG_PROTOCOL_VERSION,
  MIN_CONFIG_PROTOCOL_VERSION,
  PARAMETER_SCHEMAS,
  type ComponentParameters,
  type DiscoveryError,
  type ParametersMessage,
  type ParameterType,
  type ResetParametersCommand,
  type TypedParameters,
  type WriteParametersCommand,
} from "@rpp/protocol";
import { COMPONENTS, componentKind } from "./components";
import { PLC_CONFIG_MACHINE_TYPE, PLC_CONFIG_MANIFEST_TYPE, type ST_ConfigManifest } from "./config-contract";
import { E_VisuComponentType, enumValue } from "./plc-contract";
import { mapPlc, type EntryMemory } from "./plc-mapping";
import { plcLeaves } from "./plc-writing";
import { splitByPart, type ReadPart } from "./read-parts";
import { machineFbEntry, machineFbPart, type MachineFbEntry } from "./recipe-access";
import { resetWrites, staleBase, stageWrites, stagingStatus } from "./staging";
import { SymbolNotFoundError, isExpectedType, type SymbolAccess, type SymbolWrite } from "./symbol-access";

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
  if (!isExpectedType(type, PLC_CONFIG_MANIFEST_TYPE)) {
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
      if (!isExpectedType(actual, PLC_CONFIG_MACHINE_TYPE)) {
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
    const expected = COMPONENTS[type].plcConfigType;
    if (!isExpectedType(actual, expected)) {
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
 * The source's Syn_Config in the cyclic sum-read: of every parameter FB two paths, status and effective values; then of
 * the machine FB its recipe status, effective values and command answer; mapped into the `parameters` message.
 */
export function parametersPart(sourceId: string, d: ParameterDiscovery): ReadPart<ParametersMessage> {
  const fbs = d.entries.map(parameterFbPart);
  const machine = d.machine && machineFbPart(d.machine);
  const parts: ReadPart<unknown>[] = machine ? [...fbs, machine] : fbs;
  return {
    paths: parts.flatMap((p) => p.paths),
    map: (raws) => {
      const values = splitByPart(parts, raws);
      let components: ComponentParameters[];
      let recipe: ReturnType<NonNullable<typeof machine>["map"]> | undefined;
      try {
        components = fbs.map((p) => p.map(values.get(p)!));
        recipe = machine?.map(values.get(machine)!);
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
        ...recipe,
      };
    },
    restart: () => {
      for (const p of parts) p.restart();
    },
  };
}

/** A parameter FB in the cyclic sum-read: its status and effective values. */
function parameterFbPart(e: ParameterEntry): ReadPart<ComponentParameters> {
  return {
    paths: [`${e.path}.stStatus`, `${e.path}.stActive`],
    map: ([status, active]) => ({
      id: e.id,
      ...stagingStatus(status),
      set: { type: e.type, parameters: mapPlc(PARAMETER_SCHEMAS[e.type], active, {}, e.memory) } as TypedParameters,
    }),
    restart: () => e.memory.clear(),
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
  const entry = d.entries.find((e) => e.id === command.componentId);
  if (!entry) return { error: `Component ${command.componentId} has no parameter FB in the PLC's config manifest.` };
  const active = current?.components.find((c) => c.id === entry.id)?.activeVersion;
  if (active === undefined) return { error: `The parameter status of component ${entry.id} has not been read yet.` };
  const stale = staleBase(`Component ${entry.id} has parameter version`, active, command.baseVersion);
  if (stale) return { error: stale };
  if (command.kind === "resetParameters") return { writes: resetWrites(entry.path, command.baseVersion, stageId) };
  if (command.set.type !== entry.type) {
    return { error: `Component ${entry.id} is a ${entry.type} in the PLC, not a ${command.set.type}.` };
  }
  const set = plcLeaves(PARAMETER_SCHEMAS[entry.type], command.set.parameters, `${entry.path}.stStaged`);
  return { writes: stageWrites(entry.path, command.baseVersion, stageId, set) };
}

