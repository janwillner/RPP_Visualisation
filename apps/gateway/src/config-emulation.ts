import { CONFIG_PROTOCOL_VERSION, FIELD_TEXT_CONFIG_PROTOCOL_VERSION, PARAMETER_SCHEMAS, type ParameterType } from "@rpp/protocol";
import { COMPONENTS } from "./components";
import {
  CONFIG_MANIFEST_PATH,
  E_ConfigCommandResult,
  E_ConfigFieldType,
  E_ConfigResult,
  MAX_CHOICES,
  MAX_RECIPE_FIELDS,
  PLC_CONFIG_MACHINE_TYPE,
  PLC_CONFIG_MANIFEST_TYPE,
  type ST_ConfigComponent,
  type ST_ConfigMachine,
  type ST_ConfigManifest,
  type ST_ConfigManifestEntry,
  type ST_ConfigRecipeField,
  type ST_ConfigStaging,
  type ST_ConfigStatus,
} from "./config-contract";
import { E_VisuComponentType, enumValue } from "./plc-contract";
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

/** A recipe field as the tests declare it: a number field of the whole machine unless given otherwise. */
export function recipeField(f: Partial<ST_ConfigRecipeField> & { sName: string; choices?: string[] }): ST_ConfigRecipeField {
  const { choices = [], ...rest } = f;
  return {
    nGroup: 0,
    eType: E_ConfigFieldType.NUMBER,
    sUnit: "",
    fMin: 0,
    fMax: 0,
    fProgramValue: 0,
    nChoiceCount: choices.length,
    aChoices: [...choices, ...Array.from({ length: MAX_CHOICES - choices.length }, () => "")],
    sLabel: "",
    sDescription: "",
    nVisibleField: 0,
    nVisibleValue: 0,
    ...rest,
  };
}

/** The application's machine FB (`_FB_ConfigMachine`, config protocol 3 or later): its recipe fields at `path`. */
export interface EmulatedMachineFb {
  /** Symbol path of the machine FB's `vo_Config`. */
  path: string;
  fields: ST_ConfigRecipeField[];
}

export class ConfigEmulation {
  /** The application allows taking a staged set over (`vi_b_ApplyAllowed`). */
  applyAllowed = true;
  /** How the application answers a machine command (E_ConfigCommand): '' accepts it, a reason rejects it. */
  answerCommand: (command: number) => string = () => "";
  /** The application's persistent recipe (`ST_ConfigRecipeSet`). */
  private recipe = { bValid: false, nVersion: 0, nLastVersion: 0, aValues: [] as number[] };
  private readonly machine: EmulatedMachineFb | undefined;
  private readonly fbs: {
    entry: EmulatedParameterFb;
    defaults: Param;
    persistent: PersistentSet;
    lastVersion: number;
  }[];

  constructor(
    private readonly plc: InMemoryPlc,
    entries: EmulatedParameterFb[],
    options: { manifestPath?: string; protocolVersion?: number; visuManifestPath?: string; machine?: EmulatedMachineFb } = {},
  ) {
    this.visuManifestPath = options.visuManifestPath ?? MANIFEST_PATH;
    this.machine = options.machine;
    const listed: ST_ConfigManifestEntry[] = [
      ...entries.map((e): ST_ConfigManifestEntry => ({ nId: e.id, eType: COMPONENTS[e.kind].plcValue, sPath: e.path })),
      // The machine FB: id 0, type NONE.
      ...(options.machine ? [{ nId: 0, eType: E_VisuComponentType.NONE, sPath: options.machine.path }] : []),
    ];
    const manifest: ST_ConfigManifest = {
      nProtocolVersion: options.protocolVersion ?? CONFIG_PROTOCOL_VERSION,
      sLibraryVersion: "1.0.0",
      nCount: listed.length,
      aEntries: [...listed, ...Array.from({ length: MAX_MANIFEST_ENTRIES - listed.length }, () => ({ nId: 0, eType: 0, sPath: "" }))],
    };
    if (options.machine) {
      const { fields } = options.machine;
      // Config protocol 3 declares no label, description or condition.
      const declared = (f: ST_ConfigRecipeField): ST_ConfigRecipeField => {
        if (manifest.nProtocolVersion >= FIELD_TEXT_CONFIG_PROTOCOL_VERSION) return f;
        const { sLabel: _l, sDescription: _d, nVisibleField: _f, nVisibleValue: _v, ...older } = f;
        return older;
      };
      const values = (v: number[]) => [...v, ...Array.from({ length: MAX_RECIPE_FIELDS - v.length }, () => 0)];
      const machine: ST_ConfigMachine = {
        nFieldCount: fields.length,
        aFields: [...fields, ...Array.from({ length: MAX_RECIPE_FIELDS - fields.length }, () => recipeField({ sName: "" }))].map(declared),
        stStaging: { nBaseVersion: 0, nStageId: 0, bReset: false, bStaged: false },
        aStaged: values([]),
        stStatus: { nActiveVersion: 0, nHandledStageId: 0, eResult: E_ConfigResult.NONE, sMessage: "" },
        aActive: values(fields.map((f) => f.fProgramValue)),
        stCommand: { nCommandId: 0, eCommand: 0, bRequested: false },
        stCommandStatus: { nHandledCommandId: 0, eResult: E_ConfigCommandResult.NONE, sMessage: "" },
      };
      plc.define(options.machine.path, PLC_CONFIG_MACHINE_TYPE, machine);
    }
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
      plc.define(entry.path, COMPONENTS[entry.kind].plcConfigType, fb);
      return { entry, defaults, persistent: { bValid: false, nVersion: 0, stParam: structuredClone(defaults) }, lastVersion: 0 };
    });
  }

  private readonly visuManifestPath: string;

  /** One PLC cycle of every parameter FB and of the application passing the effective values on. */
  step(): void {
    for (const fb of this.fbs) {
      const vo = this.plc.get<ST_ConfigComponent<Param>>(fb.entry.path);
      const active = () => (fb.persistent.bValid ? fb.persistent.nVersion : 0);
      stagingCycle(vo, this.applyAllowed, active(), {
        invalid: () => this.invalid(vo.stStaged) ?? "",
        apply: () => {
          fb.lastVersion += 1;
          fb.persistent = { bValid: true, nVersion: fb.lastVersion, stParam: structuredClone(vo.stStaged) };
        },
        reset: () => {
          fb.persistent.bValid = false;
        },
      });
      vo.stStatus.nActiveVersion = active();
      vo.stActive = structuredClone(fb.persistent.bValid ? fb.persistent.stParam : fb.defaults);
      this.passOn(fb.entry, vo.stActive);
    }
    if (this.machine) this.machineCycle(this.machine);
  }

  /** What `_FB_ConfigMachine.m_Cycle` and the application's command handling do in one cycle. */
  private machineCycle(m: EmulatedMachineFb): void {
    const vo = this.plc.get<ST_ConfigMachine>(m.path);
    // As the library: the fields as declared in vo_Config.
    const fields = vo.aFields.slice(0, vo.nFieldCount);
    const active = () => (this.recipe.bValid ? this.recipe.nVersion : 0);
    stagingCycle(vo, this.applyAllowed, active(), {
      invalid: () => invalidRecipe(fields, vo.aStaged),
      apply: () => {
        this.recipe.nLastVersion += 1;
        this.recipe = { ...this.recipe, bValid: true, nVersion: this.recipe.nLastVersion, aValues: [...vo.aStaged] };
      },
      reset: () => {
        this.recipe.bValid = false;
      },
    });
    vo.stStatus.nActiveVersion = active();
    vo.aActive = fields.map((f, i) => (this.recipe.bValid ? this.recipe.aValues[i]! : f.fProgramValue)).concat(vo.aActive.slice(fields.length));

    const command = vo.stCommand;
    if (command.bRequested) {
      const reason = this.answerCommand(enumValue(command.eCommand));
      vo.stCommandStatus = {
        nHandledCommandId: command.nCommandId,
        eResult: reason ? E_ConfigCommandResult.REJECTED : E_ConfigCommandResult.ACCEPTED,
        sMessage: reason,
      };
      command.bRequested = false;
    }
  }

  /**
   * Why a staged set cannot be taken over, as the library's m_InvalidStaged says it: a count past its array, a product type
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

/**
 * What Syn_Config's staging (`m_HandleStaging`) does in one cycle, for a parameter FB and the machine FB alike: a
 * reset makes the active set invalid; a staged set waits while not allowed, else it is rejected when based on another
 * version than `active` or invalid, or taken over. Either way the staging is handled: a set still waiting is dropped
 * with a reset.
 */
function stagingCycle(
  vo: { stStaging: ST_ConfigStaging; stStatus: ST_ConfigStatus },
  applyAllowed: boolean,
  active: number,
  set: { invalid(): string; apply(): void; reset(): void },
): void {
  const { stStaging: staging, stStatus: status } = vo;
  const handled = (reason: string) => {
    Object.assign(status, { nHandledStageId: staging.nStageId, eResult: reason ? E_ConfigResult.REJECTED : E_ConfigResult.APPLIED, sMessage: reason });
    staging.bStaged = false;
    staging.bReset = false;
  };
  if (staging.bReset) {
    set.reset();
    handled("");
  } else if (staging.bStaged) {
    if (!applyAllowed) status.eResult = E_ConfigResult.PENDING;
    else if (staging.nBaseVersion !== active) handled(`Based on version ${staging.nBaseVersion}, but version ${active} is active`);
    else {
      const reason = set.invalid();
      if (!reason) set.apply();
      handled(reason);
    }
  }
}

/** The parameter fields of a Syn_Visu config: what Syn_Config holds of it, by the naming convention. */
function paramOf(kind: ParameterType, config: Record<string, unknown>): Param {
  return structuredClone(Object.fromEntries(plcMembers(PARAMETER_SCHEMAS[kind]).map((m) => [m, config[m]])));
}

/**
 * Why staged recipe values cannot be taken over, in the order the library's m_InvalidStaged checks them (the range first, a
 * switch 0 to 1; then a whole number for every type but NUMBER); '' when they can.
 */
function invalidRecipe(fields: readonly ST_ConfigRecipeField[], staged: readonly number[]): string {
  for (const [i, f] of fields.entries()) {
    const v = staged[i]!;
    const type = enumValue(f.eType);
    const [min, max] =
      type === E_ConfigFieldType.SWITCH ? [0, 1] : type === E_ConfigFieldType.CHOICE ? [0, f.nChoiceCount - 1] : [f.fMin, f.fMax];
    if (Number.isNaN(v) || v < min || v > max) return `Field ${f.sName}: ${v} is outside ${min} to ${max}`;
    if (type !== E_ConfigFieldType.NUMBER && !Number.isInteger(v)) return `Field ${f.sName}: ${v} is not a value of its type`;
  }
  return "";
}
