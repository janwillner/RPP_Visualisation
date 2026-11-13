import { CONFIG_PROTOCOL_VERSION, PARAMETER_SCHEMAS, type ParameterType } from "@rpp/protocol";
import { COMPONENTS } from "./components";
import {
  CONFIG_MANIFEST_PATH,
  E_ConfigResult,
  PLC_CONFIG_MANIFEST_TYPE,
  PLC_CONFIG_TYPES,
  type ST_ConfigComponent,
  type ST_ConfigManifest,
  type ST_ConfigManifestEntry,
} from "./config-contract";
import type { InMemoryPlc } from "./in-memory-plc";
import { MAX_MANIFEST_ENTRIES } from "./plc-builders";
import { MANIFEST_PATH, type ST_VisuFinger, type ST_VisuManifest, type ST_VisuProductType, type ST_VisuTrackModule, type ST_VisuZone } from "./plc-contract";
import { plcMembers } from "./plc-writing";

/**
 * The library Syn_Config and an application using it (ADR 0017), emulated on an in-memory PLC for the gateway
 * tests: a config manifest, one parameter FB per entry and, every `step`, what `m_Cycle` does (take over or reject
 * a staged set while allowed, reset) followed by what the application does with the effective values (pass them on
 * to Syn_Visu, whose config version then changes).
 */

export interface EmulatedParameterFb {
  /** Id of the Syn_Visu component. */
  id: number;
  kind: ParameterType;
  /** Symbol path of the parameter FB's `vo_Config`. */
  path: string;
  /** Symbol path of the Syn_Visu component's interface structure (its `stConfig` is passed the effective values). */
  visuPath: string;
}

/** A parameter structure (`ST_Config<Type>Param`): the members of the Syn_Visu config the parameter set holds. */
type Param = Record<string, unknown>;
/** A Syn_Visu component structure, of which the emulation reads and writes only `stConfig`. */
type VisuComponent = { stConfig: Record<string, unknown> };

/** What the application keeps in its `VAR PERSISTENT` variable. */
interface PersistentSet {
  bValid: boolean;
  nVersion: number;
  stParam: Param;
}

export class ConfigEmulation {
  /** The application allows taking a staged set over (`vi_b_ApplyAllowed`). */
  applyAllowed = true;
  private readonly fbs: {
    entry: EmulatedParameterFb;
    defaults: Param;
    persistent: PersistentSet;
    lastVersion: number;
  }[];

  constructor(
    private readonly plc: InMemoryPlc,
    entries: EmulatedParameterFb[],
    options: { manifestPath?: string; protocolVersion?: number; visuManifestPath?: string } = {},
  ) {
    this.visuManifestPath = options.visuManifestPath ?? MANIFEST_PATH;
    const manifest: ST_ConfigManifest = {
      nProtocolVersion: options.protocolVersion ?? CONFIG_PROTOCOL_VERSION,
      sLibraryVersion: "1.0.0",
      nCount: entries.length,
      aEntries: [
        ...entries.map((e): ST_ConfigManifestEntry => ({ nId: e.id, eType: COMPONENTS[e.kind].plcValue, sPath: e.path })),
        ...Array.from({ length: MAX_MANIFEST_ENTRIES - entries.length }, () => ({ nId: 0, eType: 0, sPath: "" })),
      ],
    };
    plc.define(options.manifestPath ?? CONFIG_MANIFEST_PATH, PLC_CONFIG_MANIFEST_TYPE, manifest);
    this.fbs = entries.map((entry) => {
      // The program values: what the application passes to Syn_Visu without a parameter set.
      const defaults = paramOf(entry.kind, plc.get<VisuComponent>(entry.visuPath).stConfig);
      const fb: ST_ConfigComponent<Param> = {
        stStaging: { nBaseVersion: 0, nStageId: 0, bReset: false, bStaged: false },
        stStaged: structuredClone(defaults),
        stStatus: { nActiveVersion: 0, nHandledStageId: 0, eResult: E_ConfigResult.NONE, sMessage: "" },
        stActive: structuredClone(defaults),
      };
      plc.define(entry.path, PLC_CONFIG_TYPES[entry.kind], fb);
      return { entry, defaults, persistent: { bValid: false, nVersion: 0, stParam: structuredClone(defaults) }, lastVersion: 0 };
    });
  }

  private readonly visuManifestPath: string;

  /** One PLC cycle of every parameter FB and of the application passing the effective values on. */
  step(): void {
    for (const fb of this.fbs) {
      const vo = this.plc.get<ST_ConfigComponent<Param>>(fb.entry.path);
      const { stStaging: staging, stStatus: status } = vo;
      const active = () => (fb.persistent.bValid ? fb.persistent.nVersion : 0);
      if (staging.bReset) {
        fb.persistent.bValid = false;
        Object.assign(status, { nHandledStageId: staging.nStageId, eResult: E_ConfigResult.APPLIED, sMessage: "" });
        // As m_Handled does: a set still waiting is dropped with the reset.
        staging.bReset = false;
        staging.bStaged = false;
      } else if (staging.bStaged) {
        if (!this.applyAllowed) {
          status.eResult = E_ConfigResult.PENDING;
        } else {
          const reason =
            staging.nBaseVersion !== active()
              ? `Based on version ${staging.nBaseVersion}, but version ${active()} is active`
              : this.invalid(vo.stStaged);
          if (reason) {
            Object.assign(status, { nHandledStageId: staging.nStageId, eResult: E_ConfigResult.REJECTED, sMessage: reason });
          } else {
            fb.lastVersion += 1;
            fb.persistent = { bValid: true, nVersion: fb.lastVersion, stParam: structuredClone(vo.stStaged) };
            Object.assign(status, { nHandledStageId: staging.nStageId, eResult: E_ConfigResult.APPLIED, sMessage: "" });
          }
          staging.bStaged = false;
        }
      }
      status.nActiveVersion = active();
      vo.stActive = structuredClone(fb.persistent.bValid ? fb.persistent.stParam : fb.defaults);
      this.passOn(fb.entry, vo.stActive);
    }
  }

  /**
   * Why a staged set cannot be taken over, as the library's m_Invalid says it: a count past its array, a product type
   * without a number or twice, a track without modules or a module without a length (checked before the zones, as
   * the XTS parameter FBs do), a zone on no conveyor, a finger without a diameter or height.
   */
  private invalid(staged: Param): string | undefined {
    const counted = <T>(list: string, count: string, name: string): T[] | string => {
      const entries = (staged[list] as T[] | undefined) ?? [];
      const n = (staged[count] as number | undefined) ?? 0;
      return n > entries.length ? `More than ${entries.length} ${name}` : entries.slice(0, n);
    };
    const types = counted<ST_VisuProductType>("aProductTypes", "nProductTypeCount", "product types");
    if (typeof types === "string") return types;
    if (types.some((t) => t.nId === 0)) return "A product type without a number";
    const twice = types.find((t, i) => types.findIndex((o) => o.nId === t.nId) < i);
    if (twice) return `Product type ${twice.nId} is defined twice`;
    if ("aModules" in staged) {
      const modules = counted<ST_VisuTrackModule>("aModules", "nModuleCount", "track modules");
      if (typeof modules === "string") return modules;
      if (modules.length === 0) return "A track without modules";
      const module = modules.findIndex((m) => m.fLength <= 0);
      if (module >= 0) return `Track module ${module + 1} has no length`;
    }
    const zones = counted<ST_VisuZone>("aZones", "nZoneCount", "zones");
    if (typeof zones === "string") return zones;
    const zone = zones.findIndex((z) => z.nConveyorId === 0);
    if (zone >= 0) return `Zone ${zone + 1} lies on no conveyor`;
    const fingers = counted<ST_VisuFinger>("aFingers", "nFingerCount", "fingers");
    if (typeof fingers === "string") return fingers;
    const finger = fingers.findIndex((f) => f.fDiameter <= 0 || f.fHeight <= 0);
    return finger >= 0 ? `Finger ${finger + 1} has no diameter or height` : undefined;
  }

  /** The application passes the effective values on to Syn_Visu, whose config version changes when they do. */
  private passOn(entry: EmulatedParameterFb, active: Param): void {
    const visu = this.plc.get<VisuComponent>(entry.visuPath).stConfig;
    const before = JSON.stringify(visu);
    Object.assign(visu, structuredClone(active));
    if (JSON.stringify(visu) !== before) this.plc.get<ST_VisuManifest>(this.visuManifestPath).nConfigVersion += 1;
  }
}

/** The parameter fields of a Syn_Visu config: what Syn_Config holds of it, by the naming convention. */
function paramOf(kind: ParameterType, config: Record<string, unknown>): Param {
  return structuredClone(Object.fromEntries(plcMembers(PARAMETER_SCHEMAS[kind]).map((m) => [m, config[m]])));
}
