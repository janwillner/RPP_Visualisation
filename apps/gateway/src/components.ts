import {
  CartesianConfigSchema,
  CartesianStateSchema,
  ConveyorConfigSchema,
  ConveyorStateSchema,
  DeltaConfigSchema,
  DeltaStateSchema,
  XtsGantryConfigSchema,
  XtsGantryStateSchema,
  XtsLoopConfigSchema,
  XtsLoopStateSchema,
  ZoneKindSchema,
  type ComponentConfig,
  type ComponentState,
} from "@rpp/protocol";
import type { z } from "zod";
import { E_VisuComponentType, E_VisuZoneKind, PLC_TYPES } from "./plc-contract";
import { mapPlc, registerEnumTable } from "./plc-mapping";

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
};

registerEnumTable(ZoneKindSchema, { [E_VisuZoneKind.PICK]: "pick", [E_VisuZoneKind.PLACE]: "place" });

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

/** Finger states are reported for every possible finger; only the configured ones are kept, also in lists such as movers. */
export function mapState(config: ComponentConfig, raw: unknown): ComponentState {
  const state = mapPlc(COMPONENTS[config.type].state, raw, { type: config.type, id: config.id }) as ComponentState;
  return withFingers(state, "fingers" in config ? config.fingers.length : 0);
}

function withFingers(state: ComponentState, count: number): ComponentState {
  const cut = (v: unknown) => {
    if (typeof v === "object" && v !== null && "fingers" in v && Array.isArray(v.fingers)) v.fingers = v.fingers.slice(0, count);
  };
  cut(state);
  for (const v of Object.values(state)) if (Array.isArray(v)) v.forEach(cut);
  return state;
}
