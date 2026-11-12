import type { ComponentConfig, ConveyorConfig, DeltaConfig } from "@rpp/protocol";

/**
 * What the configurator's palette offers, with the configuration a new component starts from. Its hardware geometry
 * (arm lengths and the like) is assumed until a PLC reports its own (ADR 0016).
 */

/** The component types the palette offers. */
export const PALETTE_TYPES = ["conveyor", "delta"] as const;
export type PaletteType = (typeof PALETTE_TYPES)[number];

/** Display name of a palette entry, also the start of a new component's name. */
export const PALETTE_LABELS: Record<PaletteType, string> = { conveyor: "Conveyor", delta: "Delta" };

/** Belt surface height of a new conveyor, mm. */
const BELT_Z = 800;
/** Base height of a new Delta, mm: its working area reaches down to a belt at BELT_Z. */
const DELTA_Z = 1900;

const origin = () => ({ x: 0, y: 0, z: 0 });

/** A new component of `type` at (x, y) on the floor plane; the height is the type's usual one. */
export function defaultComponent(
  type: PaletteType,
  identity: { id: number; sourceId: string; name: string },
  at: { x: number; y: number },
): ComponentConfig {
  switch (type) {
    case "conveyor":
      return {
        type,
        ...identity,
        pose: { x: at.x, y: at.y, z: BELT_Z, rx: 0, ry: 0, rz: 0 },
        length: 2000,
        width: 400,
        productTypes: [],
        body: true,
        originShift: origin(),
      } satisfies ConveyorConfig;
    case "delta":
      return {
        type,
        ...identity,
        pose: { x: at.x, y: at.y, z: DELTA_Z, rx: 0, ry: 0, rz: 0 },
        baseRadius: 200,
        effectorRadius: 50,
        upperArmLength: 400,
        lowerArmLength: 950,
        workingArea: { radius: 700, zMin: -1300, zMax: -700, coneHeight: 200, coneBottomRadius: 400 },
        zones: [],
        fingers: [],
        limitArea: null,
        tcpLimitArea: null,
        originShift: origin(),
      } satisfies DeltaConfig;
  }
}

/** The height a new component of `type` is placed at, MCS Z mm: a drop lands under the pointer at that height. */
export function placementHeight(type: PaletteType): number {
  return defaultComponent(type, { id: 0, sourceId: "", name: "" }, { x: 0, y: 0 }).pose.z;
}
