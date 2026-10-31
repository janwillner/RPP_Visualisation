import { z } from "zod";

/**
 * Neutral data model shared by gateway and web.
 *
 * All lengths are millimetres and all angles degrees, expressed in the MCS
 * (machine coordinate system): right-handed, Z up, X in product flow direction.
 * Conversion to the renderer's frame happens only in the web scene model.
 */

/** Version of the PLC <-> gateway contract. Must match `nProtocolVersion` in the PLC manifest. */
export const PROTOCOL_VERSION = 9;

/** Full 6-DOF pose. Rotation order: R = Rz(rz) · Ry(ry) · Rx(rx). */
export const PoseSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  rx: z.number(),
  ry: z.number(),
  rz: z.number(),
});
export type Pose = z.infer<typeof PoseSchema>;

/** A point in the MCS, e.g. a Delta's TCP. */
export const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});
export type Position = z.infer<typeof PositionSchema>;

/**
 * One finger of a gripper: always a cylinder. Its frame's origin is the centre of its top face; it extends along its
 * local −Z, and its grip point (where a carried product's top touches) is the centre of its bottom face.
 */
export const FingerSchema = z.object({
  diameter: z.number(),
  height: z.number(),
});
export type Finger = z.infer<typeof FingerSchema>;

/** Live pose of a finger's frame, absolute in the MCS, and whether it grips. */
export const FingerStateSchema = z.object({
  pose: PoseSchema,
  active: z.boolean(),
});
export type FingerState = z.infer<typeof FingerStateSchema>;

/** An active fault of a component or an XTS mover, reported live by the PLC. */
export const FaultSchema = z.object({
  /** As the PLC reports it; may be empty. */
  message: z.string(),
});
export type Fault = z.infer<typeof FaultSchema>;

/** Position plus rotation about Z, used for product latch poses. */
export const PlanarPoseSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  rz: z.number(),
});
export type PlanarPose = z.infer<typeof PlanarPoseSchema>;

/** PLC timestamp (DC time, ns) as decimal string: 64-bit values exceed JS number precision. */
export const TimestampSchema = z.string().regex(/^\d+$/);

export const ProductTypeSchema = z.object({
  id: z.number().int(),
  length: z.number(),
  width: z.number(),
  height: z.number(),
});
export type ProductType = z.infer<typeof ProductTypeSchema>;

export const ConveyorConfigSchema = z.object({
  type: z.literal("conveyor"),
  id: z.number().int(),
  sourceId: z.string(),
  name: z.string(),
  /** Pose of the belt start; local +X is the conveying direction, local Z is the belt surface normal. */
  pose: PoseSchema,
  length: z.number(),
  width: z.number(),
  productTypes: z.array(ProductTypeSchema),
  /** Origin of the component's coordinate system, mm in its local frame from `pose`; belt coordinates (zones' start, end, CCS offset) count from it. */
  originShift: PositionSchema,
});
export type ConveyorConfig = z.infer<typeof ConveyorConfigSchema>;

export const WorkingAreaSchema = z.object({
  /** Vertical cylinder in the robot's frame. */
  radius: z.number(),
  zMin: z.number(),
  zMax: z.number(),
  /** Optional cone at the bottom of the cylinder; 0 means no cone. */
  coneHeight: z.number(),
  coneBottomRadius: z.number(),
});
export type WorkingArea = z.infer<typeof WorkingAreaSchema>;

/**
 * Axis-aligned box in the robot's frame (relative to the base centre, turned with the robot's pose) that further
 * restricts the working area, e.g. so that neighbouring robots cannot collide.
 */
export const LimitAreaSchema = z.object({
  xMin: z.number(),
  xMax: z.number(),
  yMin: z.number(),
  yMax: z.number(),
  zMin: z.number(),
  zMax: z.number(),
});
export type LimitArea = z.infer<typeof LimitAreaSchema>;

export const ZoneKindSchema = z.enum(["pick", "place"]);
export type ZoneKind = z.infer<typeof ZoneKindSchema>;

export const ZoneSchema = z.object({
  conveyorId: z.number().int(),
  /** Start and end in mm along the referenced conveyor's local X axis (belt coordinates). */
  start: z.number(),
  end: z.number(),
  kind: ZoneKindSchema,
  /**
   * Distance in mm before `end`, against the conveying direction: the robot may allocate products in the zone only
   * up to `end − allocationOffset`. 0 means no allocation limit.
   */
  allocationOffset: z.number(),
  /** Belt coordinate, like `start` and `end`, of the robot's conveyor coordinate system (CCS) on this conveyor. */
  ccsOffset: z.number(),
});
export type Zone = z.infer<typeof ZoneSchema>;

export const DeltaConfigSchema = z.object({
  type: z.literal("delta"),
  id: z.number().int(),
  sourceId: z.string(),
  name: z.string(),
  /** Pose of the base centre in the MCS. */
  pose: PoseSchema,
  baseRadius: z.number(),
  effectorRadius: z.number(),
  upperArmLength: z.number(),
  lowerArmLength: z.number(),
  workingArea: WorkingAreaSchema,
  /** Null when the robot has no limit area. */
  limitArea: LimitAreaSchema.nullable(),
  zones: z.array(ZoneSchema),
  /** Gripper fingers; empty when there is no gripper definition. */
  fingers: z.array(FingerSchema),
  /** Origin of the component's coordinate system, mm in its local frame from `pose`; only where the origin is shown (origin triad, local measuring coordinates). */
  originShift: PositionSchema,
});
export type DeltaConfig = z.infer<typeof DeltaConfigSchema>;

/**
 * Straight XTS track carried by a common Z axis; every mover carries an X axis with a gripper flange at its end.
 * Local frame: origin at the track start on top of the movers with Z = 0; track along +Y, X axes along +X, Z up.
 */
export const XtsGantryConfigSchema = z.object({
  type: z.literal("xtsGantry"),
  id: z.number().int(),
  sourceId: z.string(),
  name: z.string(),
  pose: PoseSchema,
  moduleCount: z.number().int(),
  /** Length of one track module; the track is moduleCount × moduleLength long. */
  moduleLength: z.number(),
  xMin: z.number(),
  xMax: z.number(),
  zMin: z.number(),
  zMax: z.number(),
  /** Gripper flange relative to the mover at X = 0: ahead along +X, and below the mover top (negative). */
  toolOffsetX: z.number(),
  toolOffsetZ: z.number(),
  moverLength: z.number(),
  moverWidth: z.number(),
  zones: z.array(ZoneSchema),
  /** Gripper fingers of every mover; empty when there is no gripper definition. */
  fingers: z.array(FingerSchema),
  /** Origin of the component's coordinate system, mm in its local frame from `pose`; only where the origin is shown (origin triad, local measuring coordinates). */
  originShift: PositionSchema,
});
export type XtsGantryConfig = z.infer<typeof XtsGantryConfigSchema>;

/**
 * Closed XTS loop: two straights joined by two semicircles, standing in the local X-Z plane.
 * Local frame: origin at the start of the lower straight, which runs along +X; the upper straight is at +2R.
 */
export const XtsLoopConfigSchema = z.object({
  type: z.literal("xtsLoop"),
  id: z.number().int(),
  sourceId: z.string(),
  name: z.string(),
  pose: PoseSchema,
  straightLength: z.number(),
  curveRadius: z.number(),
  /** Distance of a mover's gripper flange (tool point) from the track, outwards. */
  toolOffset: z.number(),
  moverLength: z.number(),
  moverWidth: z.number(),
  zones: z.array(ZoneSchema),
  /** Gripper fingers of every mover; empty when there is no gripper definition. */
  fingers: z.array(FingerSchema),
  /** Origin of the component's coordinate system, mm in its local frame from `pose`; only where the origin is shown (origin triad, local measuring coordinates). */
  originShift: PositionSchema,
});
export type XtsLoopConfig = z.infer<typeof XtsLoopConfigSchema>;

/**
 * Cartesian robot: two fixed rails along local +Y at railHeight, a bridge travelling in Y, a carriage on it travelling
 * in X and a vertical column (Z) ending at the gripper flange.
 * Local frame: origin at axis X = Y = 0, Z up; the flange is at (X, Y, Z).
 */
export const CartesianConfigSchema = z.object({
  type: z.literal("cartesian"),
  id: z.number().int(),
  sourceId: z.string(),
  name: z.string(),
  pose: PoseSchema,
  xMin: z.number(),
  xMax: z.number(),
  yMin: z.number(),
  yMax: z.number(),
  zMin: z.number(),
  zMax: z.number(),
  /** Height of the rails and the bridge above the local origin. */
  railHeight: z.number(),
  zones: z.array(ZoneSchema),
  /** Gripper fingers; empty when the robot has no gripper definition. */
  fingers: z.array(FingerSchema),
  /** Origin of the component's coordinate system, mm in its local frame from `pose`; only where the origin is shown (origin triad, local measuring coordinates). */
  originShift: PositionSchema,
});
export type CartesianConfig = z.infer<typeof CartesianConfigSchema>;

export const ComponentConfigSchema = z.discriminatedUnion("type", [
  ConveyorConfigSchema,
  DeltaConfigSchema,
  XtsGantryConfigSchema,
  XtsLoopConfigSchema,
  CartesianConfigSchema,
]);
export type ComponentConfig = z.infer<typeof ComponentConfigSchema>;

export const ProductStateSchema = z.enum(["detected", "assigned", "picked", "rejected", "placed"]);
export type ProductState = z.infer<typeof ProductStateSchema>;

export const ProductSchema = z.object({
  id: z.number().int(),
  /** Bottom-centre of the product on the belt surface at the moment of the latch. */
  latchPose: PlanarPoseSchema,
  /** Belt position at the moment of the latch. */
  latchBeltPosition: z.number(),
  state: ProductStateSchema,
  /** Manifest id of the robot the product is assigned to; 0 = none. */
  robotId: z.number().int(),
  /** Mover of an XTS gantry or loop that carries the product; 0 = none. */
  moverId: z.number().int(),
  /** Gripper finger (1-based) the product hangs from while picked; 0 = the gripper flange. */
  fingerId: z.number().int(),
  productType: z.number().int(),
});
export type Product = z.infer<typeof ProductSchema>;

export const ConveyorStateSchema = z.object({
  type: z.literal("conveyor"),
  id: z.number().int(),
  timestamp: TimestampSchema,
  /** Continuous belt surface position in mm (no modulo). */
  beltPosition: z.number(),
  /** Valid register entries only. */
  products: z.array(ProductSchema),
  /** Active fault, null = none. */
  fault: FaultSchema.nullable(),
});
export type ConveyorState = z.infer<typeof ConveyorStateSchema>;

export const DeltaStateSchema = z.object({
  type: z.literal("delta"),
  id: z.number().int(),
  timestamp: TimestampSchema,
  /** Actual TCP (effector centre, the gripper flange) in the MCS; the arms are derived from it by inverse kinematics. */
  actualTcp: PositionSchema,
  setpointTcp: PositionSchema,
  /** One per configured finger. */
  fingers: z.array(FingerStateSchema),
  /** Active fault, null = none. */
  fault: FaultSchema.nullable(),
});
export type DeltaState = z.infer<typeof DeltaStateSchema>;

export const GantryMoverSchema = z.object({
  id: z.number().int(),
  /** Along the track (local +Y). */
  position: z.number(),
  /** X axis on the mover. */
  x: z.number(),
  /** Used only when no fingers are configured. */
  gripperActive: z.boolean(),
  /** One per configured finger. */
  fingers: z.array(FingerStateSchema),
  /** Active fault of this mover, null = none. */
  fault: FaultSchema.nullable(),
});
export type GantryMover = z.infer<typeof GantryMoverSchema>;

export const XtsGantryStateSchema = z.object({
  type: z.literal("xtsGantry"),
  id: z.number().int(),
  timestamp: TimestampSchema,
  /** Common Z axis. */
  z: z.number(),
  /** Valid movers only. */
  movers: z.array(GantryMoverSchema),
  /** Active fault of the whole gantry, null = none. */
  fault: FaultSchema.nullable(),
});
export type XtsGantryState = z.infer<typeof XtsGantryStateSchema>;

export const LoopMoverSchema = z.object({
  id: z.number().int(),
  /** Along the loop from the start of the lower straight, in the conveying direction. */
  position: z.number(),
  /** One per configured finger. */
  fingers: z.array(FingerStateSchema),
  /** Active fault of this mover, null = none. */
  fault: FaultSchema.nullable(),
});
export type LoopMover = z.infer<typeof LoopMoverSchema>;

export const XtsLoopStateSchema = z.object({
  type: z.literal("xtsLoop"),
  id: z.number().int(),
  timestamp: TimestampSchema,
  /** Valid movers only. */
  movers: z.array(LoopMoverSchema),
  /** Active fault of the whole loop, null = none. */
  fault: FaultSchema.nullable(),
});
export type XtsLoopState = z.infer<typeof XtsLoopStateSchema>;

export const CartesianStateSchema = z.object({
  type: z.literal("cartesian"),
  id: z.number().int(),
  timestamp: TimestampSchema,
  /** Actual axis values in the local frame: the gripper flange. */
  x: z.number(),
  y: z.number(),
  z: z.number(),
  /** Used only when no fingers are configured. */
  gripperActive: z.boolean(),
  /** One per configured finger. */
  fingers: z.array(FingerStateSchema),
  /** Active fault, null = none. */
  fault: FaultSchema.nullable(),
});
export type CartesianState = z.infer<typeof CartesianStateSchema>;

export const ComponentStateSchema = z.discriminatedUnion("type", [
  ConveyorStateSchema,
  DeltaStateSchema,
  XtsGantryStateSchema,
  XtsLoopStateSchema,
  CartesianStateSchema,
]);
export type ComponentState = z.infer<typeof ComponentStateSchema>;

export const DiscoveryErrorSchema = z.object({
  /** Manifest id, if the error concerns one entry. */
  componentId: z.number().int().optional(),
  path: z.string().optional(),
  message: z.string(),
});
export type DiscoveryError = z.infer<typeof DiscoveryErrorSchema>;

export const GatewayStatusSchema = z.object({
  plcConnected: z.boolean(),
  lastError: z.string().optional(),
});
export type GatewayStatus = z.infer<typeof GatewayStatusSchema>;

/**
 * A PLC the gateway reads, as `ads:<AmsNetId>:<port>` (`sim` for the simulator). Every message carries it, and manifest
 * ids are unique only within one source.
 */
export const SourceIdSchema = z.string().min(1);

export const ConfigMessageSchema = z.object({
  kind: z.literal("config"),
  sourceId: SourceIdSchema,
  protocolVersion: z.number().int(),
  configVersion: z.number().int(),
  components: z.array(ComponentConfigSchema),
  errors: z.array(DiscoveryErrorSchema),
});
export type ConfigMessage = z.infer<typeof ConfigMessageSchema>;

export const StateMessageSchema = z.object({
  kind: z.literal("state"),
  sourceId: SourceIdSchema,
  configVersion: z.number().int(),
  /** Newest PLC timestamp in this snapshot (ns, decimal string). */
  timestamp: TimestampSchema,
  /** Milliseconds relative to the first snapshot after the gateway (re)discovered this source's PLC. */
  tRel: z.number(),
  components: z.array(ComponentStateSchema),
});
export type StateMessage = z.infer<typeof StateMessageSchema>;

export const StatusMessageSchema = z.object({
  kind: z.literal("status"),
  sourceId: SourceIdSchema,
  /** Display name of the source: the configured name, else `<AmsNetId>:<port>`. */
  sourceName: z.string(),
  status: GatewayStatusSchema,
});
export type StatusMessage = z.infer<typeof StatusMessageSchema>;

export const GatewayMessageSchema = z.discriminatedUnion("kind", [
  ConfigMessageSchema,
  StateMessageSchema,
  StatusMessageSchema,
]);
export type GatewayMessage = z.infer<typeof GatewayMessageSchema>;
