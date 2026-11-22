import {
  emptyDraft,
  type Body,
  type CartesianConfig,
  type ComponentConfig,
  type ComponentType,
  type ConveyorConfig,
  type DeltaConfig,
  type Pose,
  type SensorConfig,
  type StationConfig,
  type TrackModule,
  type VisionConfig,
  type XtsGantryConfig,
  type XtsLoopConfig,
} from "@rpp/protocol";
import { XTS_MODULE_LENGTH } from "../src/component-defaults";
import type { Configurator } from "../src/configurator";
import { keyOf } from "../src/edits";

/**
 * Components of every type with plausible hardware, as a PLC or a saved draft holds them: what the tests put into a
 * draft or a fake PLC. The configurator itself adds only components its PLCs provide.
 */

/** Every component type of the protocol. */
export const SAMPLE_TYPES = ["conveyor", "delta", "xtsGantry", "xtsLoop", "cartesian", "vision", "sensor", "station"] as const satisfies readonly ComponentType[];
export type SampleType = (typeof SAMPLE_TYPES)[number];

/** The start of a sample component's name. */
const LABELS: Record<SampleType, string> = {
  conveyor: "Conveyor",
  delta: "Delta",
  xtsGantry: "XTS gantry",
  xtsLoop: "XTS loop",
  cartesian: "Cartesian",
  vision: "Vision",
  sensor: "Sensor",
  station: "Station",
};

/** Belt surface height of a conveyor, mm; the other types work on a belt at this height. */
const BELT_Z = 800;
/** Height of the products the robots are placed for, mm. */
const PRODUCT_Z = 40;
/** Base height of a Delta, mm: its working area reaches down to a belt at BELT_Z. */
const DELTA_Z = 1900;

const origin = () => ({ x: 0, y: 0, z: 0 });
const at = (x: number, y: number, z: number, rx = 0): Pose => ({ x, y, z, rx, ry: 0, rz: 0 });
const box = (pose: Pose, length: number, width: number, height: number, role: Body["role"] = "structure"): Body => ({
  shape: "box",
  role,
  pose,
  length,
  width,
  height,
  topLength: 0,
  topWidth: 0,
});
const modules = (kinds: TrackModule["kind"][]): TrackModule[] => kinds.map((kind) => ({ kind, length: XTS_MODULE_LENGTH }));
const straight = (n: number): TrackModule["kind"][] => Array.from({ length: n }, () => "straight");

/** A component of `type` at (x, y) on the floor plane; the height is the type's usual one. */
export function sampleComponent(
  type: SampleType,
  identity: { id: number; sourceId: string; name: string },
  { x, y }: { x: number; y: number },
): ComponentConfig {
  const common = { ...identity, originShift: origin() };
  const robot = { zones: [], fingers: [], limitArea: null, tcpLimitArea: null };
  switch (type) {
    case "conveyor":
      return { type, ...common, pose: at(x, y, BELT_Z), length: 2000, width: 400, productTypes: [], body: true } satisfies ConveyorConfig;
    case "delta":
      return {
        type,
        ...common,
        ...robot,
        pose: at(x, y, DELTA_Z),
        baseRadius: 200,
        effectorRadius: 50,
        upperArmLength: 400,
        lowerArmLength: 950,
        workingArea: { radius: 700, zMin: -1300, zMax: -700, coneHeight: 200, coneBottomRadius: 400 },
      } satisfies DeltaConfig;
    case "xtsGantry":
      // The flange reaches the product tops with the Z axis halfway down.
      return {
        type,
        ...common,
        ...robot,
        pose: at(x, y, BELT_Z + PRODUCT_Z + 500),
        modules: modules(straight(6)),
        xMin: 0,
        xMax: 700,
        zMin: -200,
        zMax: 0,
        toolOffsetX: 150,
        toolOffsetZ: -400,
        moverLength: 155,
        moverWidth: 80,
      } satisfies XtsGantryConfig;
    case "xtsLoop":
      // Two straights of four modules joined at each end by two left curves: the tool points at the product tops.
      return {
        type,
        ...common,
        zones: [],
        fingers: [],
        pose: at(x, y, BELT_Z + PRODUCT_Z + 120),
        modules: modules([...straight(4), "curveLeft", "curveLeft", ...straight(4), "curveLeft", "curveLeft"]),
        toolOffset: 120,
        moverLength: 100,
        moverWidth: 60,
      } satisfies XtsLoopConfig;
    case "cartesian":
      return {
        type,
        ...common,
        ...robot,
        pose: at(x, y, BELT_Z + PRODUCT_Z + 600),
        axes: "xyz",
        xMin: 0,
        xMax: 1200,
        yMin: 0,
        yMax: 1000,
        zMin: -600,
        zMax: 0,
        railHeight: 800,
      } satisfies CartesianConfig;
    case "vision":
      // As _FB_VisuVision.m_Configure describes it: housing, lens and a 400 mm field of view on the belt 800 mm below.
      return {
        type,
        ...common,
        zones: [],
        pose: at(x, y, BELT_Z + 800),
        bodies: [
          box(at(0, 0, 60), 100, 80, 140),
          { ...box(at(0, 0, 0), 50, 50, 60, "sensor"), shape: "cylinder" },
          { ...box(at(0, 0, -800), 400, 400, 800, "fieldOfView"), shape: "frustum", topLength: 50, topWidth: 50 },
        ],
      } satisfies VisionConfig;
    case "sensor":
      // A light barrier at a belt side: its head and the beam across the belt along local +Y.
      return {
        type,
        ...common,
        zones: [],
        pose: at(x, y, BELT_Z + 20),
        bodies: [
          box(at(0, 0, -30), 30, 40, 60, "sensor"),
          { ...box(at(0, 20, 0, -90), 8, 8, 500, "beam"), shape: "cylinder" },
        ],
      } satisfies SensorConfig;
    case "station":
      // A reject unit on the floor at a belt side: its housing and the pusher at the belt edge (local +Y across it).
      return {
        type,
        ...common,
        zones: [],
        pose: at(x, y, 0),
        bodies: [box(at(0, -70, 0), 160, 140, BELT_Z + 120), box(at(0, 15, BELT_Z + 10), 120, 30, 50)],
      } satisfies StationConfig;
  }
}

/** A source no PLC has: that of components a draft holds on its own. */
const DRAFT_SOURCE = "draft";

/** A sample component of the draft's own source with manifest id `id`, named like "Conveyor 1". */
export const drafted = (type: SampleType, id: number, at = { x: 0, y: 0 }): ComponentConfig =>
  sampleComponent(type, { id, sourceId: DRAFT_SOURCE, name: `${LABELS[type]} ${id}` }, at);

/** Opens a draft file holding `components` in `c` and selects the last of them; gives `c`. */
export function openDraft(c: Configurator, ...components: ComponentConfig[]): Configurator {
  c.open(JSON.stringify({ ...emptyDraft(), components }));
  const last = components.at(-1);
  if (last) c.select(keyOf(last));
  return c;
}
