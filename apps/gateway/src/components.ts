import {
  CartesianConfigSchema,
  CartesianStateSchema,
  ConveyorConfigSchema,
  ConveyorStateSchema,
  DeltaConfigSchema,
  DeltaStateSchema,
  SensorConfigSchema,
  SensorStateSchema,
  StationConfigSchema,
  StationStateSchema,
  VisionConfigSchema,
  VisionStateSchema,
  XtsGantryConfigSchema,
  XtsGantryStateSchema,
  XtsLoopConfigSchema,
  XtsLoopStateSchema,
  type ComponentConfig,
  type ComponentState,
} from "@rpp/protocol";
import type { z } from "zod";
import { E_VisuComponentType, PLC_TYPES } from "./plc-contract";
import { mapPlc } from "./plc-mapping";

export type ComponentKind = ComponentConfig["type"];

/** What the gateway needs to know about one component type: everything else follows from the schemas. */
interface ComponentSpec {
  /** `E_VisuComponentType` value in the manifest. */
  plcValue: number;
  /** PLC data type of the component's contract structure, checked during discovery. */
  plcType: string;
  config: z.ZodTypeAny;
  state: z.ZodTypeAny;
}

/**
 * Every component type the gateway reads. A new component needs its schemas in `@rpp/protocol`, its PLC structure
 * following the naming conventions of `plc-mapping.ts`, and one entry here.
 */
export const COMPONENTS: Record<ComponentKind, ComponentSpec> = {
  conveyor: {
    plcValue: E_VisuComponentType.CONVEYOR,
    plcType: PLC_TYPES.conveyor,
    config: ConveyorConfigSchema,
    state: ConveyorStateSchema,
  },
  delta: { plcValue: E_VisuComponentType.DELTA, plcType: PLC_TYPES.delta, config: DeltaConfigSchema, state: DeltaStateSchema },
  xtsGantry: {
    plcValue: E_VisuComponentType.XTS_GANTRY,
    plcType: PLC_TYPES.xtsGantry,
    config: XtsGantryConfigSchema,
    state: XtsGantryStateSchema,
  },
  xtsLoop: {
    plcValue: E_VisuComponentType.XTS_LOOP,
    plcType: PLC_TYPES.xtsLoop,
    config: XtsLoopConfigSchema,
    state: XtsLoopStateSchema,
  },
  cartesian: {
    plcValue: E_VisuComponentType.CARTESIAN,
    plcType: PLC_TYPES.cartesian,
    config: CartesianConfigSchema,
    state: CartesianStateSchema,
  },
  vision: { plcValue: E_VisuComponentType.VISION, plcType: PLC_TYPES.vision, config: VisionConfigSchema, state: VisionStateSchema },
  sensor: { plcValue: E_VisuComponentType.SENSOR, plcType: PLC_TYPES.sensor, config: SensorConfigSchema, state: SensorStateSchema },
  station: {
    plcValue: E_VisuComponentType.STATION,
    plcType: PLC_TYPES.station,
    config: StationConfigSchema,
    state: StationStateSchema,
  },
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
  return mapPlc(COMPONENTS[kind].config, raw, { type: kind, ...identity }) as ComponentConfig;
}

/**
 * The PLC reports a state for every possible finger or body; only as many as the config has are kept, also in the
 * entries of lists such as movers.
 */
export function mapState(config: ComponentConfig, raw: unknown): ComponentState {
  const state = mapPlc(COMPONENTS[config.type].state, raw, { type: config.type, id: config.id }) as ComponentState;
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
