import { z } from "zod";

/**
 * Neutral data model shared by gateway and web.
 *
 * All lengths are millimetres and all angles degrees, expressed in the MCS
 * (machine coordinate system): right-handed, Z up, X in product flow direction.
 * Conversion to the renderer's frame happens only in the web scene model.
 */

/** Version of the PLC <-> gateway contract. Must match `nProtocolVersion` in the PLC manifest. */
export const PROTOCOL_VERSION = 2;

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

/** Position plus rotation about Z, used for TCPs and product latch poses. */
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
});
export type ConveyorConfig = z.infer<typeof ConveyorConfigSchema>;

export const WorkAreaSchema = z.object({
  /** Vertical cylinder in the robot's frame. */
  radius: z.number(),
  zMin: z.number(),
  zMax: z.number(),
  /** Optional cone at the bottom of the cylinder; 0 means no cone. */
  coneHeight: z.number(),
  coneBottomRadius: z.number(),
});
export type WorkArea = z.infer<typeof WorkAreaSchema>;

export const WindowKindSchema = z.enum(["pick", "place"]);
export type WindowKind = z.infer<typeof WindowKindSchema>;

export const WindowSchema = z.object({
  conveyorId: z.number().int(),
  /** Start and end in mm along the referenced conveyor's local X axis (belt coordinates). */
  start: z.number(),
  end: z.number(),
  kind: WindowKindSchema,
});
export type Window = z.infer<typeof WindowSchema>;

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
  /** When true, the effector is drawn rotated by the TCP's rz (4th axis). */
  hasRotationAxis: z.boolean(),
  workArea: WorkAreaSchema,
  windows: z.array(WindowSchema),
});
export type DeltaConfig = z.infer<typeof DeltaConfigSchema>;

export const ComponentConfigSchema = z.discriminatedUnion("type", [ConveyorConfigSchema, DeltaConfigSchema]);
export type ComponentConfig = z.infer<typeof ComponentConfigSchema>;

export const ProductStateSchema = z.enum(["detected", "assigned", "picked", "rejected", "placed"]);
export type ProductState = z.infer<typeof ProductStateSchema>;

export const ProductSchema = z.object({
  id: z.number().int(),
  /** Bottom-centre of the product on the belt surface at the moment of the latch. */
  latchPose: PlanarPoseSchema,
  /** Conveyor encoder value at the moment of the latch. */
  latchEncoder: z.number(),
  state: ProductStateSchema,
  /** Manifest id of the robot the product is assigned to; 0 = none. */
  robotId: z.number().int(),
  productType: z.number().int(),
});
export type Product = z.infer<typeof ProductSchema>;

export const ConveyorStateSchema = z.object({
  type: z.literal("conveyor"),
  id: z.number().int(),
  timestamp: TimestampSchema,
  /** Continuous belt surface position in mm (no modulo). */
  encoder: z.number(),
  /** Valid register entries only. */
  products: z.array(ProductSchema),
});
export type ConveyorState = z.infer<typeof ConveyorStateSchema>;

export const DeltaStateSchema = z.object({
  type: z.literal("delta"),
  id: z.number().int(),
  timestamp: TimestampSchema,
  /** Actual TCP (effector centre) in the MCS; the arms are derived from it by inverse kinematics. */
  actualTcp: PlanarPoseSchema,
  setpointTcp: PlanarPoseSchema,
});
export type DeltaState = z.infer<typeof DeltaStateSchema>;

export const ComponentStateSchema = z.discriminatedUnion("type", [ConveyorStateSchema, DeltaStateSchema]);
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

export const ConfigMessageSchema = z.object({
  kind: z.literal("config"),
  protocolVersion: z.number().int(),
  configVersion: z.number().int(),
  components: z.array(ComponentConfigSchema),
  errors: z.array(DiscoveryErrorSchema),
});
export type ConfigMessage = z.infer<typeof ConfigMessageSchema>;

export const StateMessageSchema = z.object({
  kind: z.literal("state"),
  configVersion: z.number().int(),
  /** Newest PLC timestamp in this snapshot (ns, decimal string). */
  timestamp: TimestampSchema,
  /** Milliseconds relative to the first snapshot after the gateway (re)discovered the PLC. */
  tRel: z.number(),
  components: z.array(ComponentStateSchema),
});
export type StateMessage = z.infer<typeof StateMessageSchema>;

export const StatusMessageSchema = z.object({
  kind: z.literal("status"),
  status: GatewayStatusSchema,
});
export type StatusMessage = z.infer<typeof StatusMessageSchema>;

export const GatewayMessageSchema = z.discriminatedUnion("kind", [
  ConfigMessageSchema,
  StateMessageSchema,
  StatusMessageSchema,
]);
export type GatewayMessage = z.infer<typeof GatewayMessageSchema>;
