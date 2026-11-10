import { CONFIG_PROTOCOL_VERSION } from "@rpp/protocol";
import { COMPONENTS } from "./components";
import {
  CONFIG_MANIFEST_PATH,
  E_ConfigResult,
  PLC_CONFIG_MANIFEST_TYPE,
  PLC_CONFIG_TYPES,
  type ST_ConfigComponent,
  type ST_ConfigConveyorParam,
  type ST_ConfigDeltaParam,
  type ST_ConfigManifest,
  type ST_ConfigManifestEntry,
} from "./config-contract";
import type { InMemoryPlc } from "./in-memory-plc";
import { MAX_MANIFEST_ENTRIES } from "./plc-builders";
import { MANIFEST_PATH, type ST_VisuConveyor, type ST_VisuDelta, type ST_VisuManifest } from "./plc-contract";

/**
 * The library Syn_Config and an application using it (ADR 0017), emulated on an in-memory PLC for the simulator and
 * the tests: a config manifest, one parameter FB per entry and, every `step`, what `m_Cycle` does (take over or reject
 * a staged set while allowed, reset) followed by what the application does with the effective values (pass them on
 * to Syn_Visu, whose config version then changes).
 */

export interface EmulatedParameterFb {
  /** Id of the Syn_Visu component. */
  id: number;
  kind: keyof typeof PLC_CONFIG_TYPES;
  /** Symbol path of the parameter FB's `vo_Config`. */
  path: string;
  /** Symbol path of the Syn_Visu component's interface structure (its `stConfig` is passed the effective values). */
  visuPath: string;
}

type Param = ST_ConfigConveyorParam | ST_ConfigDeltaParam;

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
      const defaults = paramOf(entry.kind, plc.get<ST_VisuConveyor | ST_VisuDelta>(entry.visuPath).stConfig);
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
              : this.invalid(fb.entry.kind, vo.stStaged);
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
   * without a number or twice, a zone on no conveyor.
   */
  private invalid(kind: EmulatedParameterFb["kind"], staged: Param): string | undefined {
    if (kind === "conveyor") {
      const p = staged as ST_ConfigConveyorParam;
      if (p.nProductTypeCount > p.aProductTypes.length) return `More than ${p.aProductTypes.length} product types`;
      const types = p.aProductTypes.slice(0, p.nProductTypeCount);
      if (types.some((t) => t.nId === 0)) return "A product type without a number";
      const twice = types.find((t, i) => types.findIndex((o) => o.nId === t.nId) < i);
      return twice ? `Product type ${twice.nId} is defined twice` : undefined;
    }
    const p = staged as ST_ConfigDeltaParam;
    if (p.nZoneCount > p.aZones.length) return `More than ${p.aZones.length} zones`;
    const zone = p.aZones.slice(0, p.nZoneCount).findIndex((z) => z.nConveyorId === 0);
    return zone >= 0 ? `Zone ${zone + 1} lies on no conveyor` : undefined;
  }

  /** The application passes the effective values on to Syn_Visu, whose config version changes when they do. */
  private passOn(entry: EmulatedParameterFb, active: Param): void {
    const visu = this.plc.get<ST_VisuConveyor | ST_VisuDelta>(entry.visuPath).stConfig as unknown as Record<string, unknown>;
    const before = JSON.stringify(visu);
    Object.assign(visu, structuredClone(active));
    if (JSON.stringify(visu) !== before) this.plc.get<ST_VisuManifest>(this.visuManifestPath).nConfigVersion += 1;
  }
}

/** The parameter fields of a Syn_Visu config: what Syn_Config holds of it. */
function paramOf(kind: EmulatedParameterFb["kind"], config: ST_VisuConveyor["stConfig"] | ST_VisuDelta["stConfig"]): Param {
  if (kind === "conveyor") {
    const c = config as ST_VisuConveyor["stConfig"];
    return structuredClone({
      stPose: c.stPose,
      stOriginShift: c.stOriginShift,
      nProductTypeCount: c.nProductTypeCount,
      aProductTypes: c.aProductTypes,
    });
  }
  const c = config as ST_VisuDelta["stConfig"];
  return structuredClone({
    stPose: c.stPose,
    stOriginShift: c.stOriginShift,
    nZoneCount: c.nZoneCount,
    aZones: c.aZones,
    stWorkingArea: c.stWorkingArea,
    stLimitArea: c.stLimitArea,
    stTcpLimitArea: c.stTcpLimitArea,
  });
}
