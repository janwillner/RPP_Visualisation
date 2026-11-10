import { z } from "zod";

/**
 * Neutral data model shared by gateway and web.
 *
 * All lengths are millimetres and all angles degrees, expressed in the MCS
 * (machine coordinate system): right-handed, Z up, X in product flow direction.
 * Conversion to the renderer's frame happens only in the web scene model.
 *
 * Every schema and field carries a `.describe()` text: the JSON Schema the gateway serves at `/docs/schema.json` is
 * generated from them (ADR 0012), and a test fails for a field without one.
 */

/** Version of the PLC <-> gateway contract. Must match `nProtocolVersion` in the PLC manifest. */
export const PROTOCOL_VERSION = 19;

const mm = (description: string) => z.number().describe(description);
const deg = (description: string) => z.number().describe(description);
const int = (description: string) => z.number().int().describe(description);

/** Full 6-DOF pose. Rotation order: R = Rz(rz) · Ry(ry) · Rx(rx). */
export const PoseSchema = z
  .object({
    x: mm("Position along X, mm."),
    y: mm("Position along Y, mm."),
    z: mm("Position along Z, mm."),
    rx: deg("Rotation about X, degrees."),
    ry: deg("Rotation about Y, degrees."),
    rz: deg("Rotation about Z, degrees."),
  })
  .describe("Position and orientation with 6 degrees of freedom. Rotation order: R = Rz(rz) · Ry(ry) · Rx(rx).");
export type Pose = z.infer<typeof PoseSchema>;

/** A point in the MCS, e.g. a Delta's TCP. */
export const PositionSchema = z
  .object({
    x: mm("X, mm."),
    y: mm("Y, mm."),
    z: mm("Z, mm."),
  })
  .describe("A point, mm.");
export type Position = z.infer<typeof PositionSchema>;

/**
 * One finger of a gripper: always a cylinder. Its frame's origin is the centre of its top face; it extends along its
 * local −Z, and its grip point (where a carried product's top touches) is the centre of its bottom face.
 */
export const FingerSchema = z
  .object({
    diameter: mm("Diameter of the finger's cylinder, mm."),
    height: mm("Length of the cylinder along the finger's local −Z, mm."),
  })
  .describe(
    "One finger of a gripper: always a cylinder. Its frame's origin is the centre of its top face; it extends along " +
      "its local −Z, and its grip point (where a carried product's top touches) is the centre of its bottom face.",
  );
export type Finger = z.infer<typeof FingerSchema>;

/** Live pose of a finger's frame, absolute in the MCS, and whether it grips. */
export const FingerStateSchema = z
  .object({
    pose: PoseSchema.describe("Pose of the finger's frame (centre of its top face), absolute in the MCS."),
    active: z.boolean().describe("The finger grips (vacuum on, jaws closed)."),
  })
  .describe("Live pose of a finger and whether it grips.");
export type FingerState = z.infer<typeof FingerStateSchema>;

/** An active fault of a component, an XTS mover or a track module, reported live by the PLC. */
export const FaultSchema = z
  .object({
    message: z.string().describe("Fault text as the PLC reports it; may be empty."),
  })
  .describe("An active fault of a component, an XTS mover or a track module.");
export type Fault = z.infer<typeof FaultSchema>;

/** Position plus rotation about Z, used for product latch poses (in the conveyor's coordinate system). */
export const PlanarPoseSchema = z
  .object({
    x: mm("X, mm."),
    y: mm("Y, mm."),
    z: mm("Z, mm."),
    rz: deg("Rotation about Z, degrees."),
  })
  .describe("Position plus rotation about Z.");
export type PlanarPose = z.infer<typeof PlanarPoseSchema>;

/** PLC timestamp (DC time, ns) as decimal string: 64-bit values exceed JS number precision. */
export const TimestampSchema = z
  .string()
  .regex(/^\d+$/)
  .describe(
    "PLC timestamp: EtherCAT distributed clock time in ns since 2000-01-01, as a decimal string, since 64-bit " +
      "values exceed the precision of a JSON number.",
  );

/**
 * A product type's solid: a box; a cylinder whose length and width are its two diameters along and across the
 * conveying direction (equal: round, different: oval); a box with rounded vertical edges of `cornerRadius`.
 */
export const ProductShapeSchema = z
  .enum(["box", "cylinder", "roundedBox"])
  .describe(
    "A product type's solid: `box`; `cylinder`, whose length and width are its two diameters along and across the " +
      "conveying direction (equal: round, different: oval); `roundedBox`, a box with rounded vertical edges of " +
      "`cornerRadius`.",
  );
export type ProductShape = z.infer<typeof ProductShapeSchema>;

export const ProductTypeSchema = z
  .object({
    id: int("Product type number, referenced by `Product.productType`."),
    length: mm("Size along the conveying direction, mm."),
    width: mm("Size across the conveying direction, mm."),
    height: mm("Height, mm."),
    shape: ProductShapeSchema,
    cornerRadius: mm("Radius of the rounded vertical edges of a `roundedBox`, mm; 0 for the other shapes."),
  })
  .describe("A kind of product a conveyor carries, with its size and solid.");
export type ProductType = z.infer<typeof ProductTypeSchema>;

const componentKind = <K extends string>(type: K) => z.literal(type).describe(`Component type: always \`${type}\`.`);

/**
 * The configuration every component has: its manifest identity, its pose in the MCS and its origin shift (origin of
 * the component's coordinate system, mm in its local frame from `pose`; a conveyor's belt coordinates count from it,
 * other components use it where the origin is shown: origin triad, local measuring coordinates).
 */
function componentConfig<K extends string, S extends z.ZodRawShape>(type: K, shape: S, description: string) {
  return z
    .object({
      type: componentKind(type),
      id: int("Manifest id: unique within the source, referenced by zones, products and the component's state."),
      sourceId: z.string().describe("The source (PLC) the component belongs to; equals the message's `sourceId`."),
      name: z.string().describe("Display name from the manifest."),
      pose: PoseSchema.describe("Pose of the component's local frame in the MCS."),
      ...shape,
      originShift: PositionSchema.describe(
        "Origin of the component's coordinate system, mm in its local frame from `pose`. A conveyor's belt " +
          "coordinates count from it; other components use it where their origin is shown (origin triad, local " +
          "measuring coordinates).",
      ),
    })
    .describe(description);
}

/** The state every component reports: its PLC timestamp and its active fault (null = none). */
function componentState<K extends string, S extends z.ZodRawShape>(type: K, shape: S, description: string) {
  return z
    .object({
      type: componentKind(type),
      id: int("Manifest id of the component, as in its config."),
      timestamp: TimestampSchema.describe("PLC time at which the component's state was taken (ns, decimal string)."),
      ...shape,
      fault: FaultSchema.nullable().describe("The component's active fault; null = none."),
    })
    .describe(description);
}

/** Conveyor: `pose` is the belt start; local +X is the conveying direction, local Z is the belt surface normal. */
export const ConveyorConfigSchema = componentConfig(
  "conveyor",
  {
    length: mm("Belt length along local +X, mm."),
    width: mm("Belt width, mm."),
    productTypes: z.array(ProductTypeSchema).describe("The product types this conveyor carries."),
    body: z
      .boolean()
      .describe(
        "Whether the belt is drawn as a body; false = a conveyor without one: only its products, zones and axis are drawn.",
      ),
  },
  "Conveyor: `pose` is the belt start; local +X is the conveying direction, local Z the belt surface normal.",
);
export type ConveyorConfig = z.infer<typeof ConveyorConfigSchema>;

export const WorkingAreaSchema = z
  .object({
    radius: mm("Radius of the vertical cylinder, mm."),
    zMin: mm("Bottom of the cylinder in the robot's frame, mm."),
    zMax: mm("Top of the cylinder in the robot's frame, mm."),
    coneHeight: mm("Height of an optional cone below the cylinder, mm; 0 means no cone."),
    coneBottomRadius: mm("Radius of the cone's bottom face, mm."),
  })
  .describe("Where a Delta's TCP can go: a vertical cylinder in the robot's frame, optionally with a cone below.");
export type WorkingArea = z.infer<typeof WorkingAreaSchema>;

/**
 * Axis-aligned box in the robot's frame (relative to its pose, turned with it; the frame its working area is given in)
 * that further restricts the working area, e.g. so that neighbouring robots cannot collide.
 */
export const LimitAreaSchema = z
  .object({
    xMin: mm("Lower X bound, mm."),
    xMax: mm("Upper X bound, mm."),
    yMin: mm("Lower Y bound, mm."),
    yMax: mm("Upper Y bound, mm."),
    zMin: mm("Lower Z bound, mm."),
    zMax: mm("Upper Z bound, mm."),
  })
  .describe(
    "Axis-aligned box in the robot's frame (relative to its `pose`, turned with it: the frame its working area is " +
      "given in) that further restricts the working area, e.g. so that neighbouring robots cannot collide. A bound " +
      "pair with min = max is a flat box.",
  );
export type LimitArea = z.infer<typeof LimitAreaSchema>;

/**
 * A stretch of a conveyor that belongs to a component: where a robot picks or places, where a detector detects. What
 * the component does there is its own business; the visualisation draws every zone alike.
 */
export const ZoneSchema = z
  .object({
    conveyorId: int("Manifest id of the conveyor the zone lies on."),
    start: mm("Start in belt coordinates (mm along the conveyor's local X, from its origin shift)."),
    end: mm("End in belt coordinates, mm; equal to `start` for a line."),
    allocationOffset: mm(
      "Distance before `end`, against the conveying direction, mm: the robot may allocate products in the zone " +
        "only up to `end − allocationOffset`. 0 means no allocation limit.",
    ),
    ccsOffset: mm("Belt coordinate of the robot's conveyor coordinate system (CCS) on this conveyor, mm."),
    startY: mm(
      "One side of the zone across the belt: Y in the conveyor's coordinate system (its `pose` moved by its " +
        "`originShift`), mm. Equal to `endY` for a zone across the whole belt width.",
    ),
    endY: mm("The other side of the zone across the belt, mm; in any order with `startY`."),
  })
  .describe(
    "A stretch of a conveyor that belongs to a component: where a robot picks or places, where a detector detects. " +
      "The visualisation draws every zone alike.",
  );
export type Zone = z.infer<typeof ZoneSchema>;

/** A robot's configuration: a component with zones on conveyors and gripper fingers (empty: no gripper definition). */
function robotConfig<K extends string, S extends z.ZodRawShape>(type: K, shape: S, description: string) {
  return componentConfig(
    type,
    {
      ...shape,
      zones: z.array(ZoneSchema).describe("The robot's zones on conveyors."),
      fingers: z.array(FingerSchema).describe("Gripper fingers; empty when the gripper is not described."),
    },
    description,
  );
}

/**
 * A robot whose working area a limit area may restrict further (Delta, XTS gantry, Cartesian; not the XTS loop, which
 * has no working area of its own): a robot plus the optional `limitArea` and the optional `tcpLimitArea` around its
 * TCP (on an XTS gantry around every mover's gripper flange).
 */
function limitedRobotConfig<K extends string, S extends z.ZodRawShape>(type: K, shape: S, description: string) {
  return robotConfig(
    type,
    {
      ...shape,
      limitArea: LimitAreaSchema.nullable().describe("Further restriction of the working area; null = none."),
      tcpLimitArea: LimitAreaSchema.nullable().describe(
        "Box around the TCP (on an XTS gantry around every mover's gripper flange): bounds relative to the TCP along " +
          "the axes of the robot's frame; it moves with the TCP and never turns. Clients flag it when it overlaps " +
          "another robot's limit area or another TCP limit area (also another mover's of the same gantry), or when " +
          "it leaves the robot's own `limitArea`. null = none.",
      ),
    },
    description,
  );
}

/** Delta robot: `pose` is the base centre in the MCS. */
export const DeltaConfigSchema = limitedRobotConfig(
  "delta",
  {
    baseRadius: mm("Distance from the base centre to the upper arms' axes, mm."),
    effectorRadius: mm("Distance from the effector centre (TCP) to the lower arms' joints, mm."),
    upperArmLength: mm("Length of an upper arm, mm."),
    lowerArmLength: mm("Length of a lower arm, mm."),
    workingArea: WorkingAreaSchema,
  },
  "Delta robot: `pose` is the base centre. It reports only its TCP; clients derive the arms by inverse kinematics.",
);
export type DeltaConfig = z.infer<typeof DeltaConfigSchema>;

/**
 * What a track module is: a straight one, or a curve module that turns the track by a quarter circle (90°) to the left
 * or the right of the direction it runs in.
 */
export const TrackModuleKindSchema = z
  .enum(["straight", "curveLeft", "curveRight"])
  .describe(
    "A straight module, or a curve module that turns the track by a quarter circle (90°) to the left or the right of " +
      "the direction it runs in.",
  );
export type TrackModuleKind = z.infer<typeof TrackModuleKindSchema>;

/** One XTS motor module of a track, in the order the movers run along it. */
export const TrackModuleSchema = z
  .object({
    kind: TrackModuleKindSchema,
    length: mm("Length along the track (track positions), mm; a curve module is a quarter circle of this length."),
  })
  .describe("One XTS motor module of a track, in the order the movers run along it.");
export type TrackModule = z.infer<typeof TrackModuleSchema>;

/** Live state of a track module: its active fault, null = none. */
export const TrackModuleStateSchema = z
  .object({
    fault: FaultSchema.nullable().describe("The module's active fault; null = none."),
  })
  .describe("Live state of a track module.");
export type TrackModuleState = z.infer<typeof TrackModuleStateSchema>;

const trackModules = (description: string) => z.array(TrackModuleSchema).describe(description);
const moverLength = () => mm("Length of a mover along the track, mm.");
const moverWidth = () => mm("Width of a mover across the track, mm.");

/**
 * Straight XTS track carried by a common Z axis; every mover carries an X axis with a gripper flange at its end.
 * Local frame: origin at the track start on top of the movers with Z = 0; track along +Y, X axes along +X, Z up.
 */
export const XtsGantryConfigSchema = limitedRobotConfig(
  "xtsGantry",
  {
    modules: trackModules(
      "Track modules from the track start along +Y; straight modules only in practice, curves turn in the local X-Y " +
        "plane.",
    ),
    xMin: mm("Lower limit of the movers' X axes, mm."),
    xMax: mm("Upper limit of the movers' X axes, mm."),
    zMin: mm("Lower limit of the common Z axis, mm."),
    zMax: mm("Upper limit of the common Z axis, mm."),
    toolOffsetX: mm("Gripper flange relative to the mover at X = 0, along +X, mm."),
    toolOffsetZ: mm("Gripper flange below the mover top, mm (negative)."),
    moverLength: moverLength(),
    moverWidth: moverWidth(),
  },
  "XTS gantry: a straight XTS track carried by a common Z axis; every mover carries an X axis with a gripper flange " +
    "at its end. Local frame: origin at the track start on top of the movers with Z = 0; track along +Y, X axes " +
    "along +X, Z up.",
);
export type XtsGantryConfig = z.infer<typeof XtsGantryConfigSchema>;

/**
 * Closed XTS loop standing in the local X-Z plane, e.g. two straights joined at each end by two left curve modules.
 * Local frame: origin at the start of the first module, which runs along +X; a left curve turns up towards +Z.
 */
export const XtsLoopConfigSchema = robotConfig(
  "xtsLoop",
  {
    modules: trackModules("Track modules in the conveying direction from the origin; the chain ends where it starts."),
    toolOffset: mm("Distance of a mover's gripper flange (tool point) from the track, outwards, mm."),
    moverLength: moverLength(),
    moverWidth: moverWidth(),
  },
  "XTS loop: a closed XTS track standing in the local X-Z plane, e.g. two straights joined at each end by two left " +
    "curve modules. Local frame: origin at the start of the first module, which runs along +X; a left curve turns " +
    "up towards +Z.",
);
export type XtsLoopConfig = z.infer<typeof XtsLoopConfigSchema>;

/**
 * Which axes a Cartesian robot has: `xyz` (rails, bridge, carriage, column), `xz` (no Y axis: a fixed beam along X,
 * carriage, column) or `xy` (no Z axis: rails, bridge, carriage, a column of fixed length).
 */
export const CartesianAxesSchema = z
  .enum(["xyz", "xz", "xy"])
  .describe(
    "Which axes the robot has: `xyz`; `xz`, no Y axis (a fixed beam along local X at `railHeight`, Y is always 0: " +
      "`yMin`, `yMax` and the state's `y` are ignored); `xy`, no Z axis (the column has a fixed length and the " +
      "flange stays at `zMin`: `zMax` and the state's `z` are ignored).",
  );
export type CartesianAxes = z.infer<typeof CartesianAxesSchema>;

/**
 * Cartesian robot: two fixed rails along local +Y at railHeight, a bridge travelling in Y, a carriage on it travelling
 * in X and a vertical column (Z) ending at the gripper flange. Without a Y axis (`xz`) a fixed beam along X at
 * railHeight replaces rails and bridge; without a Z axis (`xy`) the column has a fixed length down to zMin.
 * Local frame: origin at axis X = Y = 0, Z up; the flange is at (X, Y, Z).
 */
export const CartesianConfigSchema = limitedRobotConfig(
  "cartesian",
  {
    axes: CartesianAxesSchema,
    xMin: mm("Lower limit of the X axis, mm."),
    xMax: mm("Upper limit of the X axis, mm."),
    yMin: mm("Lower limit of the Y axis, mm; ignored without a Y axis (`xz`)."),
    yMax: mm("Upper limit of the Y axis, mm; ignored without a Y axis (`xz`)."),
    zMin: mm("Lower limit of the Z axis, mm; without a Z axis (`xy`) the fixed height of the flange."),
    zMax: mm("Upper limit of the Z axis, mm; ignored without a Z axis (`xy`)."),
    railHeight: mm("Height of the rails and the bridge (of the beam without a Y axis) above the local origin, mm."),
  },
  "Cartesian robot: two fixed rails along local +Y at `railHeight`, a bridge travelling in Y, a carriage on it " +
    "travelling in X and a vertical column (Z) ending at the gripper flange; `axes` may leave out Y (a fixed beam " +
    "along X instead of rails and bridge) or Z (a column of fixed length). Local frame: origin at axis X = Y = 0, " +
    "Z up; the flange is at (X, Y, Z).",
);
export type CartesianConfig = z.infer<typeof CartesianConfigSchema>;

export const BodyShapeSchema = z
  .enum(["box", "cylinder", "frustum"])
  .describe(
    "Solid of a body: `box`; `cylinder` (length and width are its two diameters); `frustum`, a rectangular pyramid " +
      "stump, e.g. a camera's field of view.",
  );
export type BodyShape = z.infer<typeof BodyShapeSchema>;

/**
 * What a body stands for, which sets its look: `structure` and `sensor` are machine parts (lit, with shadows; a
 * sensor head in its own colour), `beam` and `fieldOfView` are overlays on the zones layer.
 */
export const BodyRoleSchema = z
  .enum(["structure", "sensor", "beam", "fieldOfView"])
  .describe(
    "What a body stands for, which sets its look: `structure` and `sensor` are machine parts (a sensor head in its " +
      "own colour), `beam` and `fieldOfView` are overlays.",
  );
export type BodyRole = z.infer<typeof BodyRoleSchema>;

/**
 * One solid of a component described by the PLC, so the visualisation draws it without knowing the component: a box,
 * a cylinder (length and width are its two diameters) or a frustum (a rectangular pyramid stump, e.g. a camera's
 * field of view), standing on its bottom face.
 */
export const BodySchema = z
  .object({
    shape: BodyShapeSchema,
    role: BodyRoleSchema,
    pose: PoseSchema.describe(
      "Bottom centre in the component's frame (from its `pose`); the body extends along its local +Z.",
    ),
    length: mm("Size of the bottom face along local X, mm."),
    width: mm("Size of the bottom face along local Y, mm."),
    height: mm("Height along local +Z, mm."),
    topLength: mm("Size of a frustum's top face along local X, mm; ignored for the other shapes."),
    topWidth: mm("Size of a frustum's top face along local Y, mm; ignored for the other shapes."),
  })
  .describe(
    "One solid of a component as the PLC describes it, so a client can draw the component without knowing its " +
      "kind. It stands on its bottom face.",
  );
export type Body = z.infer<typeof BodySchema>;

export const BodyStateSchema = z
  .object({
    active: z
      .boolean()
      .describe("The body is active and lights up, e.g. a sensor's interrupted beam or a reject unit's pusher."),
  })
  .describe("Live state of a body.");
export type BodyState = z.infer<typeof BodyStateSchema>;

/**
 * A component drawn from the bodies the PLC describes, with zones on conveyors: detectors (vision system, sensor)
 * detect products in their zones, a station works on them.
 */
const bodyComponentConfig = () => ({
  zones: z.array(ZoneSchema).describe("The component's zones on conveyors."),
  bodies: z.array(BodySchema).describe("The solids the component is drawn from."),
});
const bodyComponentState = () => ({
  bodies: z.array(BodyStateSchema).describe("One per configured body, in the same order."),
});

/** Vision system: a camera over a conveyor; `pose` is its lens, looking along local −Z. */
export const VisionConfigSchema = componentConfig(
  "vision",
  bodyComponentConfig(),
  "Vision system (a detector): a camera over a conveyor; `pose` is its lens, looking along local −Z.",
);
export type VisionConfig = z.infer<typeof VisionConfigSchema>;

/** Product sensor, e.g. a light barrier; `pose` is its head at the belt side. */
export const SensorConfigSchema = componentConfig(
  "sensor",
  bodyComponentConfig(),
  "Product sensor (a detector), e.g. a light barrier; `pose` is its head at the belt side.",
);
export type SensorConfig = z.infer<typeof SensorConfigSchema>;

/**
 * Station: a client at a conveyor that works on the products in its zones (reject unit, labeller, printer, check
 * weigher), drawn from its bodies; `pose` is its origin.
 */
export const StationConfigSchema = componentConfig(
  "station",
  bodyComponentConfig(),
  "Station: a client at a conveyor that works on the products in its zones (reject unit, labeller, printer, check " +
    "weigher), drawn from its bodies; `pose` is its origin.",
);
export type StationConfig = z.infer<typeof StationConfigSchema>;

const productStates = ["detected", "assigned", "picked", "rejected", "placed"] as const;

export const ProductStateSchema = z
  .enum(productStates)
  .describe(
    "Where a product is in its life: `detected` (latched by a detector), `assigned` (to a robot), `picked` (hangs at " +
      "a gripper), `rejected` (by a station) or `placed`.",
  );
export type ProductState = z.infer<typeof ProductStateSchema>;

export const ProductSchema = z
  .object({
    id: int("Product id, unique within its conveyor's register."),
    latchPose: PlanarPoseSchema.describe(
      "Bottom centre of the product on the belt surface at the moment of the latch, in the conveyor's coordinate " +
        "system (its `pose` moved by its `originShift`: X along the belt, rotation about Z from the belt's X).",
    ),
    latchBeltPosition: mm(
      "`beltPosition` of the conveyor at the moment of the latch, mm. While the product lies on the belt, its X in " +
        "the conveyor's coordinate system is `latchPose.x + beltPosition − latchBeltPosition`.",
    ),
    state: ProductStateSchema,
    previousState: z.enum(productStates).describe("The state before the last change; equals `state` until then."),
    lastClientId: int(
      "Manifest id of the client that made the last change: the detector or station that latched it, the robot it " +
        "is assigned to, picked by or placed by, the station that rejected it; 0 = none given.",
    ),
    moverId: int("Mover of an XTS gantry or loop that carries the product, when the last client is one; 0 = none."),
    fingerId: int("Gripper finger (1-based) the product hangs from while picked; 0 = the gripper flange."),
    productType: int("`id` of one of the conveyor's `productTypes`."),
  })
  .describe("A product in a conveyor's register.");
export type Product = z.infer<typeof ProductSchema>;

export const ConveyorStateSchema = componentState(
  "conveyor",
  {
    beltPosition: mm("Continuous belt surface position, mm (no modulo)."),
    products: z.array(ProductSchema).describe("The product register: valid entries only."),
  },
  "Live state of a conveyor: belt position and product register.",
);
export type ConveyorState = z.infer<typeof ConveyorStateSchema>;

const fingerStates = () =>
  z.array(FingerStateSchema).describe("One per configured finger, in the same order as the config's `fingers`.");

export const DeltaStateSchema = componentState(
  "delta",
  {
    actualTcp: PositionSchema.describe(
      "Actual TCP (effector centre, the gripper flange) in the MCS; the arms follow from it by inverse kinematics.",
    ),
    setpointTcp: PositionSchema.describe("Setpoint TCP in the MCS."),
    fingers: fingerStates(),
  },
  "Live state of a Delta robot.",
);
export type DeltaState = z.infer<typeof DeltaStateSchema>;

const moverFault = () => FaultSchema.nullable().describe("The mover's active fault; null = none.");

export const GantryMoverSchema = z
  .object({
    id: int("Mover number."),
    position: mm("Position along the track (local +Y), mm."),
    x: mm("Value of the X axis on the mover, mm."),
    gripperActive: z.boolean().describe("The gripper grips; used only when no fingers are configured."),
    fingers: fingerStates(),
    fault: moverFault(),
  })
  .describe("A mover of an XTS gantry with its X axis.");
export type GantryMover = z.infer<typeof GantryMoverSchema>;

const moduleStates = () =>
  z.array(TrackModuleStateSchema).describe("One per configured track module, in the same order.");

export const XtsGantryStateSchema = componentState(
  "xtsGantry",
  {
    z: mm("Value of the common Z axis, mm."),
    movers: z.array(GantryMoverSchema).describe("Valid movers only."),
    modules: moduleStates(),
  },
  "Live state of an XTS gantry.",
);
export type XtsGantryState = z.infer<typeof XtsGantryStateSchema>;

export const LoopMoverSchema = z
  .object({
    id: int("Mover number."),
    position: mm("Position along the loop from the start of the first module, in the conveying direction, mm."),
    fingers: fingerStates(),
    fault: moverFault(),
  })
  .describe("A mover of an XTS loop.");
export type LoopMover = z.infer<typeof LoopMoverSchema>;

export const XtsLoopStateSchema = componentState(
  "xtsLoop",
  {
    movers: z.array(LoopMoverSchema).describe("Valid movers only."),
    modules: moduleStates(),
  },
  "Live state of an XTS loop.",
);
export type XtsLoopState = z.infer<typeof XtsLoopStateSchema>;

export const CartesianStateSchema = componentState(
  "cartesian",
  {
    x: mm("Actual X axis value in the local frame, mm."),
    y: mm("Actual Y axis value in the local frame, mm; ignored without a Y axis (`xz`)."),
    z: mm("Actual Z axis value in the local frame, mm; (x, y, z) is the gripper flange; ignored without a Z axis (`xy`)."),
    gripperActive: z.boolean().describe("The gripper grips; used only when no fingers are configured."),
    fingers: fingerStates(),
  },
  "Live state of a Cartesian robot.",
);
export type CartesianState = z.infer<typeof CartesianStateSchema>;

export const VisionStateSchema = componentState("vision", bodyComponentState(), "Live state of a vision system.");
export type VisionState = z.infer<typeof VisionStateSchema>;

export const SensorStateSchema = componentState("sensor", bodyComponentState(), "Live state of a product sensor.");
export type SensorState = z.infer<typeof SensorStateSchema>;

export const StationStateSchema = componentState("station", bodyComponentState(), "Live state of a station.");
export type StationState = z.infer<typeof StationStateSchema>;

/**
 * Every component type with its config and state schema, keyed by its `type`: the one list of component types. Both
 * unions below, the gateway's registry and the scene's kits follow from it; a new type needs one entry here.
 */
export const COMPONENT_SCHEMAS = {
  conveyor: { config: ConveyorConfigSchema, state: ConveyorStateSchema },
  delta: { config: DeltaConfigSchema, state: DeltaStateSchema },
  xtsGantry: { config: XtsGantryConfigSchema, state: XtsGantryStateSchema },
  xtsLoop: { config: XtsLoopConfigSchema, state: XtsLoopStateSchema },
  cartesian: { config: CartesianConfigSchema, state: CartesianStateSchema },
  vision: { config: VisionConfigSchema, state: VisionStateSchema },
  sensor: { config: SensorConfigSchema, state: SensorStateSchema },
  station: { config: StationConfigSchema, state: StationStateSchema },
} as const;
export type ComponentType = keyof typeof COMPONENT_SCHEMAS;

type ComponentSchemas = (typeof COMPONENT_SCHEMAS)[ComponentType];

/** The schemas of one side (config or state) of every component type, as a discriminated union needs them. */
function schemasOf<S extends keyof ComponentSchemas>(side: S): [ComponentSchemas[S], ...ComponentSchemas[S][]] {
  return Object.values(COMPONENT_SCHEMAS).map((s) => s[side]) as [ComponentSchemas[S], ...ComponentSchemas[S][]];
}

export const ComponentConfigSchema = z
  .discriminatedUnion("type", schemasOf("config"))
  .describe("The configuration of one component, by its `type`.");
export type ComponentConfig = z.infer<typeof ComponentConfigSchema>;

export const ComponentStateSchema = z
  .discriminatedUnion("type", schemasOf("state"))
  .describe("The live state of one component, by its `type`.");
export type ComponentState = z.infer<typeof ComponentStateSchema>;

export const DiscoveryErrorSchema = z
  .object({
    componentId: int("Manifest id, if the error concerns one entry.").optional(),
    path: z.string().describe("PLC symbol path concerned, if any.").optional(),
    message: z.string().describe("What went wrong."),
  })
  .describe("A problem found while discovering the PLC; the entry concerned is left out of `components`.");
export type DiscoveryError = z.infer<typeof DiscoveryErrorSchema>;

export const GatewayStatusSchema = z
  .object({
    plcConnected: z.boolean().describe("The gateway currently reads this PLC."),
    lastError: z.string().describe("Why the last attempt to read the PLC failed; absent when none failed.").optional(),
  })
  .describe("Whether the gateway reads the source's PLC.");
export type GatewayStatus = z.infer<typeof GatewayStatusSchema>;

/**
 * A PLC the gateway reads, as `ads:<AmsNetId>:<port>` (`sim` for the simulator). Every message carries it, and manifest
 * ids are unique only within one source.
 */
export const SourceIdSchema = z
  .string()
  .min(1)
  .describe(
    "The PLC (source) the message is about, as `ads:<AmsNetId>:<port>` (`sim` for the simulator). Manifest ids are " +
      "unique only within one source.",
  );

export const ConfigMessageSchema = z
  .object({
    kind: z.literal("config").describe("Message kind: always `config`."),
    sourceId: SourceIdSchema,
    protocolVersion: int("Protocol version of the PLC contract and these messages; see `PROTOCOL_VERSION`."),
    libraryVersion: z
      .string()
      .describe("Version of the Syn_Visu library the PLC runs; absent for libraries older than 5.1.")
      .optional(),
    configVersion: int(
      "Changes whenever the PLC's configuration changes. A state belongs to the config with the same `configVersion`.",
    ),
    components: z.array(ComponentConfigSchema).describe("Every component discovered without error."),
    errors: z.array(DiscoveryErrorSchema).describe("Problems found during discovery; empty when there were none."),
  })
  .describe(
    "The configuration of one source: what the machine consists of. Sent after discovery, whenever the PLC's " +
      "configuration changes, and to every new client right after it connects.",
  );
export type ConfigMessage = z.infer<typeof ConfigMessageSchema>;

export const StateMessageSchema = z
  .object({
    kind: z.literal("state").describe("Message kind: always `state`."),
    sourceId: SourceIdSchema,
    configVersion: int("The `configVersion` of the config this state belongs to."),
    timestamp: TimestampSchema.describe("Newest PLC timestamp in this snapshot (ns, decimal string)."),
    tRel: z
      .number()
      .describe("Milliseconds since the first snapshot after the gateway (re)discovered this source's PLC."),
    components: z.array(ComponentStateSchema).describe("One live state per configured component."),
    registers: z
      .record(z.array(z.number().int()))
      .describe(
        "Only for a client that asked for changes (`/ws?changes=1`): per conveyor id the ids of its whole product " +
          "register, in order. That conveyor's `products` then hold only the products that changed since the " +
          "previous state of this source on this connection; the others are unchanged. The first state of a source " +
          "after connecting, and after a missed one, lists every product.",
      )
      .optional(),
  })
  .describe(
    "A snapshot of every component's live state of one source, sent every acquisition cycle (20 ms by default). A " +
      "client that cannot keep up misses some of them.",
  );
export type StateMessage = z.infer<typeof StateMessageSchema>;

export const StatusMessageSchema = z
  .object({
    kind: z.literal("status").describe("Message kind: always `status`."),
    sourceId: SourceIdSchema,
    sourceName: z.string().describe("Display name of the source: the configured name, else `<AmsNetId>:<port>`."),
    status: GatewayStatusSchema,
  })
  .describe(
    "Whether the gateway reads one source's PLC. Sent when it changes, and to every new client right after it " +
      "connects.",
  );
export type StatusMessage = z.infer<typeof StatusMessageSchema>;

export const GatewayMessageSchema = z
  .discriminatedUnion("kind", [ConfigMessageSchema, StateMessageSchema, StatusMessageSchema])
  .describe("Every message the gateway sends on the WebSocket, one JSON object per WebSocket text message.");
export type GatewayMessage = z.infer<typeof GatewayMessageSchema>;
