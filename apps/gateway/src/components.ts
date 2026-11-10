import { COMPONENT_SCHEMAS, type ComponentConfig, type ComponentState, type ComponentType } from "@rpp/protocol";
import { mapPlc, type EntryMemory } from "./plc-mapping";

export type ComponentKind = ComponentType;

/** Where a component type lives in the PLC; everything else follows from its schemas in `@rpp/protocol`. */
interface PlcComponentType {
  /** `E_VisuComponentType` value in the manifest (library Syn_Visu; appended, never renumbered). */
  plcValue: number;
  /** PLC data type of the component's contract structure, checked during discovery. */
  plcType: string;
}

/**
 * Every component type the gateway reads, by its `E_VisuComponentType` value and contract structure. A new component
 * needs its schemas in `COMPONENT_SCHEMAS` (`@rpp/protocol`), its PLC structure following the naming conventions of
 * `plc-mapping.ts`, and one entry here; the compiler asks for it.
 */
export const COMPONENTS: Record<ComponentKind, PlcComponentType> = {
  conveyor: { plcValue: 1, plcType: "ST_VisuConveyor" },
  delta: { plcValue: 2, plcType: "ST_VisuDelta" },
  xtsGantry: { plcValue: 3, plcType: "ST_VisuXtsGantry" },
  xtsLoop: { plcValue: 4, plcType: "ST_VisuXtsLoop" },
  cartesian: { plcValue: 5, plcType: "ST_VisuCartesian" },
  vision: { plcValue: 6, plcType: "ST_VisuDetector" },
  sensor: { plcValue: 7, plcType: "ST_VisuDetector" },
  station: { plcValue: 8, plcType: "ST_VisuStation" },
};

/** The component type of a manifest entry's `eType`, undefined when unknown. */
export function componentKind(plcValue: number): ComponentKind | undefined {
  return (Object.keys(COMPONENTS) as ComponentKind[]).find((k) => COMPONENTS[k].plcValue === plcValue);
}

export interface ComponentIdentity {
  id: number;
  sourceId: string;
  name: string;
}

export function mapConfig(kind: ComponentKind, identity: ComponentIdentity, raw: unknown): ComponentConfig {
  return mapPlc(COMPONENT_SCHEMAS[kind].config, raw, { type: kind, ...identity }) as ComponentConfig;
}

/**
 * The PLC reports a state for every possible finger or body; only as many as the config has are kept, also in the
 * entries of lists such as movers.
 */
export function mapState(config: ComponentConfig, raw: unknown, memory?: EntryMemory): ComponentState {
  const state = mapPlc(COMPONENT_SCHEMAS[config.type].state, raw, { type: config.type, id: config.id }, memory) as ComponentState;
  return withConfiguredCounts(state, config);
}

/** Cuts every list of the state named like a list of the config (fingers, bodies) to the config's length. */
function withConfiguredCounts(state: ComponentState, config: ComponentConfig): ComponentState {
  const lists = Object.entries(config).filter((e): e is [string, unknown[]] => Array.isArray(e[1]));
  const cut = (v: unknown) => {
    if (typeof v !== "object" || v === null) return;
    const entry = v as Record<string, unknown>;
    for (const [key, list] of lists) {
      const values = entry[key];
      if (Array.isArray(values)) entry[key] = values.slice(0, list.length);
    }
  };
  cut(state);
  for (const v of Object.values(state)) if (Array.isArray(v)) v.forEach(cut);
  return state;
}
