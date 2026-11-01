# PLC contract (library `Syn_Visu`, protocol version 12)

This is the PLC side of the contract the gateway reads. It is implemented by the TwinCAT library project in
`plc/Syn_Visu` (solution `plc/RPP_Visu.sln`). The TypeScript mirror is `apps/gateway/src/plc-contract.ts`,
and the gateway maps it to the neutral model in `packages/protocol`. Change all three together, and bump
`VISU_GlobalConst.VISU_un_PROTOCOL_VERSION` / `PROTOCOL_VERSION` on any breaking change. Adding a component type:
`docs/adding-a-component.md`. How to use the library in a machine project, task by task: `docs/plc-library-guide.md`.

The library follows the company guideline in `docs/plc-coding-guidelines.md` (`_FB_`, `m_`, `vi_`/`vo_`/`vio_`
prefixes) except for the contract itself: the structures, their members, the enums and `GVL_Visu.stManifest` keep
their Beckhoff-style names, because the gateway reads them.

## Layout in the repo

| Path | Content |
| --- | --- |
| `plc/RPP_Visu.sln` | TwinCAT solution with both PLC projects |
| `plc/Syn_Visu/` | The library project: structures, enums, constants and the component function blocks. No task, no application code. |
| `plc/Syn_Visu_Demo/` | The demo application. It references the installed library like any machine project, so it also tests the library from the outside. ADS port 852. `PlcTask` calls `P_VisuDemo`, which sets the shared cycle time and fault phase (`DEMO_GlobalVar`) and calls one program per application: `P_VisuDemoDelta`, `P_VisuDemoFxx`, `P_VisuDemoIdh`, `P_VisuDemoCartesian`, `P_VisuDemoSpacing`. Shared constants (belt height and width, product, suction cup, fault timing) are in `DEMO_GlobalConst`, the manifest in `GVL_Visu`. |
| `plc/library/Syn_Visu_<version>.library` | The exported library, committed for every released version. Machine projects install it from here. |

Releasing a version: bump `_FC_GetVersionSynVisu`, `VISU_GlobalConst.VISU_str_LIBRARY_VERSION` and the project
version (Properties → Common), build, export it with
"Save as library and install" to `plc/library/Syn_Visu_<version>.library`, update the demo's reference and build again.
The library is installed under the title `SynVisu` from `Syntegon Group`; its namespace is `SynVisu` too, so machine
projects qualify library objects as `SynVisu._FB_VisuConveyor`, `SynVisu.ST_VisuPose` and so on (the demo uses them
unqualified).

## Naming of the contract structures

The gateway has no mapping code per component: it reads each structure by walking the protocol's schema and finding
every field's PLC member by these rules (`apps/gateway/src/plc-mapping.ts`). Every contract structure must keep them.

- A member is the protocol field with a Hungarian prefix and an upper-case first letter: `fLength` → `length`,
  `stOriginShift` → `originShift`, `aZones` → `zones`, `nConveyorId` → `conveyorId`.
- An array `aZones` is cut to its count member, named after one entry: `nZoneCount`, `nBodyCount`. Without a count
  member the whole array is read. Entries with a `bValid` member are kept only while it is TRUE.
- A structure for a value that may be absent (a fault, the Delta's limit area) has a `bActive` member: FALSE means
  none.
- An enumeration's value is the index of the protocol's option (`E_VisuProductShape.CYLINDER` = 1 = `"cylinder"`).
- Live states of the config's lists sit in `aFingerStates` and `aBodyStates`; the gateway keeps as many as the config
  has (also per mover).
- `nTimestamp` (ULINT) becomes a decimal string.

## Conventions

- MCS: mm and degrees, right-handed, Z up, X in product flow direction.
- Pose rotation order: R = Rz(fRz) · Ry(fRy) · Rx(fRx).
- `nTimestamp`: distributed-clock time in ns since 2000-01-01 of the cycle that wrote the state. The component FBs set it.
- Cross-references (`nRobotId`, `nDetectorId`, `nConveyorId`) use manifest `nId` values, never symbol paths; `nMoverId` uses the mover ids an XTS gantry or loop reports.
- Fault: every component state, every XTS mover and every track module (`aModuleStates[i]`) carries `stFault : ST_VisuFault` (`bActive`, `sMessage` STRING(80)). While `bActive` is TRUE the visualisation draws the component, or only that mover or module, red and shows `sMessage` ("Fault" if empty) above it, in the component list, in the inspector and as a mark on the recording's timeline. There is one fault per component, mover or module at a time and no severity. Faults are live state: they are read every cycle and not interpolated.
- `fBeltPosition` is a continuous position in mm (no modulo). For modulo axes use `_FB_VisuConveyor.m_SetModuloBeltPosition`.
- Product latch pose = bottom centre of the product on the belt surface when it was latched.
- Delta: the PLC reports only the **TCP** (effector centre, the gripper flange) as a position in the MCS. The
  visualisation derives the arm posture by inverse kinematics from the configured geometry: arm 1 lies along the
  base's local +X, arms 2 and 3 follow counter-clockwise (seen from above) at 120°; 0° = upper arm horizontal,
  positive = downward. The effector stays turned with the base; a 4th axis shows only through the finger poses.
- Delta limit area: an optional axis-aligned box in the robot frame (relative to the base centre, turned with the
  base pose) that further restricts the working area, e.g. so that neighbouring robots cannot collide. It is drawn
  only while `stLimitArea.bActive` is TRUE.
- Zone: a stretch of a conveyor that belongs to a component, set with `m_SetZone(vi_un_Zone, ...)` (1-based, in
  order): where a robot picks or places, where a detector detects. What the component does there is its own business;
  the visualisation draws every zone alike. `fStart = fEnd` is a line across the belt, e.g. for a light barrier.
- Zone allocation: `fAllocationOffset` is the distance in mm before `fEnd`, against the conveying direction, up to
  which a robot may still allocate products in the zone, so it does not move out of the zone while approaching. The
  allocation area runs from `fStart` to `fEnd − fAllocationOffset` (never beyond `fStart`); 0 = no allocation limit.
- Zone CCS: `fCcsOffset` is the belt coordinate (like `fStart` / `fEnd`) of the component's conveyor coordinate system
  (CCS) on that conveyor. It is drawn as a black dashed line across the zone, in the zones layer, and is a
  measure-mode snap point. A CCS outside its zone raises a warning.
- Origin shift: every config has `stOriginShift : ST_VisuPosition`, mm in the component's local frame from `stPose`
  (no rotation), where the component's coordinate system lies; 0 = at the pose. The origin triad and the local
  measuring coordinates are shown from there. For a conveyor the belt coordinates also count from it: a zone's
  `fStart`, `fEnd` and `fCcsOffset` are measured along the belt from `stOriginShift.fX` (its Y and Z move only the
  shown origin). For robots only the shown origin moves; geometry, working and limit area, axis values and mover
  positions stay relative to `stPose`. MCS values (latch poses, finger poses, TCP) are not affected.
- XTS track (XTS gantry and XTS loop): a chain of track modules (`nModuleCount`, `aModules`, at most
  `VISU_GlobalConst_Param.VISU_un_MAX_MODULES`) in the order the movers run along it, each starting where the one
  before it ends. A module is `STRAIGHT` or a quarter curve (`CURVE_LEFT`, `CURVE_RIGHT`: 90° to the left or right
  of the direction the track runs in), `fLength` long along the track: `VISU_GlobalConst.VISU_lr_XTS_MODULE_LENGTH`
  (250 mm) for a Beckhoff XTS motor module. A curve module is drawn as a quarter circle of that length (radius
  2 · 250 / π ≈ 159.2 mm), so mover positions on it are exact along the track. Track positions count from the start
  of module 1. The visualisation draws every module on its own, with a joint between modules, and red while its
  `aModuleStates[i].stFault` is active (`m_SetModuleFault`).
- XTS gantry (e.g. IDH): local frame at the track start on top of the movers with Z = 0; the track runs along local +Y
  (a curve would turn in the local X-Y plane), each mover's X axis along local +X, the common Z axis along local +Z. Gripper flange of a mover in the local frame:
  (X + `fToolOffsetX`, position, Z + `fToolOffsetZ`). Only actual values are reported; a gripper rotation (C) shows
  only through the finger poses.
- XTS loop (e.g. Fxx): local frame at the start of module 1, which runs along local +X; the loop stands in the local
  X-Z plane and a left curve turns up towards +Z. A usual loop is a straight of n modules, two `CURVE_LEFT`, n
  straight modules back and two `CURVE_LEFT` down to the start. Mover positions run from 0 to `m_TrackLength()` in the
  conveying direction. The chain should close: if its end lies more than 1 mm from its start the visualisation warns.
  A mover's gripper flange (tool point) lies `fToolOffset` outwards (to the right of its travel) from the track.
- Cartesian robot: two fixed rails along local +Y with their top at `fRailHeight`, a bridge travelling in Y on them, a
  carriage on the bridge travelling in X and a vertical column (Z) ending at the gripper flange. Local frame: origin at
  axis X = Y = 0, Z up; the flange is at (X, Y, Z). Only actual values are reported; gripper rotations (e.g. C and A)
  show only through the finger poses. The parts are drawn with fixed sizes derived from the strokes; the working-area
  box is the flange volume.
- Detector (vision system, product sensor): it detects products in its zones; the application latches them on the
  conveyor itself with `m_LatchProduct(..., vi_udn_DetectorId := fb_Detector.m_Id())`, and the product history and
  the metrics name the detector. It is drawn from the bodies it describes (`aBodies`, at most
  `VISU_GlobalConst_Param.VISU_un_MAX_BODIES`): a box, a cylinder (length and width are its diameters) or a frustum
  (bottom `fLength` × `fWidth`, top `fTopLength` × `fTopWidth`), standing on its bottom centre `stPose` in the
  detector's frame and extending along its local +Z. Its role sets the look: `STRUCTURE` and `SENSOR` are machine
  parts (a sensor part in its own colour), `BEAM` and `FIELD_OF_VIEW` are overlays on the zones layer that light up
  while `aBodyStates[i].bActive`. A vision system's pose is its lens, looking along its local −Z; a sensor's pose is
  its head, its beam along the local +Y. The visualisation has no code of its own for detectors.
- Gripper: every kinematics may define fingers (`nFingerCount`, `aFingers`, at most `VISU_GlobalConst_Param.VISU_un_MAX_FINGERS`),
  always drawn as cylinders (`fDiameter`, `fHeight`). The PLC reports each finger's pose every cycle, **absolute in
  the MCS** (`aFingerStates[i].stPose`, per mover for XTS kinematics), and whether it grips (`bActive`). A finger's
  frame has its origin at the centre of the finger's top face; the finger extends along its local −Z, and its grip
  point is the centre of its bottom face. A thin rod connects each finger to its gripper flange. Without fingers the
  flange is drawn as a plate coloured by `bGripperActive`.
- A product in state PICKED hangs from robot `nRobotId`, mover `nMoverId` (0 for a robot without movers) and finger
  `nFingerId` (1-based): its top touches the finger's grip point and it takes the finger's full orientation. With
  `nFingerId` = 0 (or an unknown finger, which also raises a warning) it hangs at the gripper flange, turned with the
  robot. When placing, set the product's latch `fRz` to the finger's MCS rotation about Z so it stays turned on the
  belt.
- Protocol version 2 removed the Delta axis positions (`aAxisPositions`) and axis calibration (`aAxes`) of version 1.
- Protocol version 3 renamed `stWorkArea` to `stWorkingArea` and the windows (`nWindowCount`, `aWindows`, `ST_VisuWindow`, `E_VisuWindowKind`) to zones (`nZoneCount`, `aZones`, `ST_VisuZone`, `E_VisuZoneKind`).
- Protocol version 4 added the XTS gantry and XTS loop and the product's `nMoverId`, and renamed `fEncoder` to `fBeltPosition` and `fLatchEncoder` to `fLatchBeltPosition`.
- Protocol version 5 added the Cartesian robot.
- Protocol version 6 added the Delta limit area (`stLimitArea`, `ST_VisuLimitArea`) and the zones' `fAllocationOffset`.
- Protocol version 7 added gripper fingers (`ST_VisuFinger`, `ST_VisuFingerState`, `nFingerCount`, `aFingers`, `aFingerStates`, the product's `nFingerId`) and removed the tool rotations: the Delta's `bHasRotationAxis` and TCP `fRz` (the TCP is now an `ST_VisuPosition`), the XTS gantry's `fCMin`/`fCMax` and mover `fC`, and the Cartesian robot's `fCMin`/`fCMax`/`fAMin`/`fAMax`/`fToolLength` and `fC`/`fA`.
- Protocol version 8 added faults (`ST_VisuFault`, `stFault` in every component state and every XTS mover).
- Protocol version 9 added the zones' `fCcsOffset` and `stOriginShift` in every config.
- Protocol version 10 added the product type's `eShape` (`E_VisuProductShape`) and `fCornerRadius`.
- Protocol version 11 removed the zone kind (`ST_VisuZone.eKind`, `E_VisuZoneKind`), added the product's `nDetectorId`
  and the vision system and product sensor (`ST_VisuDetector`, `ST_VisuBody`, `ST_VisuBodyState`, `E_VisuBodyShape`,
  `E_VisuBodyRole`, `E_VisuComponentType.VISION` and `SENSOR`).
- Protocol version 12 made XTS tracks chains of track modules: `nModuleCount` and `aModules` (`ST_VisuTrackModule`,
  `E_VisuModuleKind`) replace the gantry's `nModuleCount`/`fModuleLength` and the loop's `fStraightLength`/
  `fCurveRadius`; the states gained `aModuleStates` (`ST_VisuTrackModuleState`) with a fault per module.

## What the library contains

Applications use the component function blocks. The structures underneath are the contract the gateway reads;
the FBs fill them in their output `vo_Visu`, so application code does not write them directly.

| Object | Purpose |
| --- | --- |
| `_FB_VisuConveyor` | One conveyor with its product register (methods below) |
| `_FB_VisuDelta` | One Delta robot (methods below) |
| `_FB_VisuXtsGantry` | One XTS gantry, e.g. IDH (methods below) |
| `_FB_VisuXtsLoop` | One XTS loop, e.g. Fxx (methods below) |
| `_FB_VisuCartesian` | One Cartesian robot (methods below) |
| `_FB_VisuVision` | One vision system (methods below) |
| `_FB_VisuSensor` | One product sensor, e.g. a light barrier (methods below) |
| `_FB_VisuComponent` | Abstract base of all: `m_Register`, `m_Id`, config version and DC timestamps |
| `_FB_VisuZoneComponent` | Abstract base of every component with zones: `m_SetZone`, `m_ClearZones`; the derived FB tells where its zones lie (`m_Zones`) |
| `_FB_VisuRobot` | Abstract base of the robots: zones plus `m_SetFinger`, `m_ClearFingers` (`m_Fingers`) |
| `_FB_VisuXtsTrack` | Abstract base of the XTS kinematics: a robot plus its track of modules (`m_SetModule`, `m_ClearModules`, `m_SetModuleFault`, `m_TrackLength`; `m_Modules`) |
| `_FB_VisuDetector` | Abstract base of the detectors: zones plus bodies (`m_SetBody`, `m_ClearBodies`, `m_SetBodyActive`) |
| `ST_VisuManifest`, `ST_VisuManifestEntry`, `E_VisuComponentType` | Discovery: which components exist and where |
| `ST_VisuConveyor` (`stConfig` / `stState`), `ST_VisuProduct`, `ST_VisuProductType` (size, `eShape`, `fCornerRadius`), `E_VisuProductState`, `E_VisuProductShape` | Conveyor contract structure (`_FB_VisuConveyor.vo_Visu`) |
| `ST_VisuDelta` (`stConfig`: geometry, working area, limit area, zones, fingers / `stState`: actual and setpoint TCP, finger states), `ST_VisuWorkingArea`, `ST_VisuLimitArea`, `ST_VisuZone` | Delta contract structure (`_FB_VisuDelta.vo_Visu`) |
| `ST_VisuXtsGantry` (`stConfig`: track modules, strokes, gripper offsets, mover size, zones, fingers / `stState`: Z, movers with finger states, module states), `ST_VisuGantryMover` | XTS gantry contract structure (`_FB_VisuXtsGantry.vo_Visu`) |
| `ST_VisuXtsLoop` (`stConfig`: track modules, tool offset, mover size, zones, fingers / `stState`: movers with finger states, module states), `ST_VisuLoopMover` | XTS loop contract structure (`_FB_VisuXtsLoop.vo_Visu`) |
| `ST_VisuTrackModule`, `ST_VisuTrackModuleState`, `E_VisuModuleKind` | One module of an XTS track (kind, length) and its live fault |
| `ST_VisuCartesian` (`stConfig`: X/Y/Z strokes, rail height, zones, fingers / `stState`: X, Y, Z, gripper, finger states) | Cartesian robot contract structure (`_FB_VisuCartesian.vo_Visu`) |
| `ST_VisuDetector` (`stConfig`: pose, zones, bodies / `stState`: body states), `ST_VisuBody`, `ST_VisuBodyState`, `E_VisuBodyShape`, `E_VisuBodyRole` | Contract structure of a vision system or product sensor (`_FB_VisuDetector.vo_Visu`) |
| `ST_VisuFault` | Fault of a component, a mover or a track module: `bActive`, `sMessage` |
| `ST_VisuFinger`, `ST_VisuFingerState` | Gripper finger (cylinder size) and its live MCS pose and grip state |
| `ST_VisuPose`, `ST_VisuPlanarPose`, `ST_VisuPosition` | MCS poses and positions |
| `VISU_GlobalConst` | `VISU_un_PROTOCOL_VERSION` (contract version; `ST_VisuManifest` initialises to it), `VISU_str_LIBRARY_VERSION` (this library's version, reported in the manifest), `VISU_lr_DEG_TO_RAD`, `VISU_lr_XTS_MODULE_LENGTH` (250 mm) |
| `VISU_GlobalConst_Param` | Array sizes: `VISU_un_MAX_MANIFEST_ENTRIES` (32), `VISU_un_MAX_PRODUCTS` (128), `VISU_un_MAX_PRODUCT_TYPES` (8), `VISU_un_MAX_ZONES` (8), `VISU_un_MAX_MOVERS` (40), `VISU_un_MAX_FINGERS` (8, per gripper), `VISU_un_MAX_BODIES` (16, per detector), `VISU_un_MAX_MODULES` (64, per XTS track) |
| `_FC_GetVersionSynVisu` | Library version at runtime (5.0.0) |

### Methods

Input names carry the guideline prefixes: `vi_` plus the type (`udn_` UDINT, `un_` UINT, `lr_` LREAL, `b_` BOOL,
`str_` STRING, `e_` enum, none for structures), `vio_` for in-outs, `vo_` for outputs.

All component FBs:

| Method | Purpose |
| --- | --- |
| `m_Register(vio_Manifest, vi_udn_Id, vi_str_Name, vi_str_Path)` | Adds the component to the manifest (bumps `nConfigVersion` when new). `vi_str_Path` is the symbol path of the instance's `vo_Visu`. Idempotent: call it every cycle, which also keeps `nProtocolVersion` and `sLibraryVersion` current and the manifest reference valid after an online change |
| `m_Id()` | Manifest id given to `m_Register`, 0 before |
| `m_SetFault(vi_b_Active, vi_str_Message)` | Sets or clears the component's fault; it stays until cleared with `m_SetFault(FALSE, '')` |
| `m_SetOriginShift(vi_lr_X, vi_lr_Y := 0, vi_lr_Z := 0)` | Moves the component's coordinate system from its pose (local frame, mm); for a conveyor the belt coordinates count from there |

All configuration methods may be called every cycle: they bump `nConfigVersion` only when a value actually changes,
and return TRUE in that case.

All robot and detector FBs (`_FB_VisuZoneComponent`):

| Method | Purpose |
| --- | --- |
| `m_SetZone(vi_un_Zone, vi_udn_ConveyorId, vi_lr_Start, vi_lr_End, vi_lr_AllocationOffset := 0, vi_lr_CcsOffset := 0)` | Sets zone `vi_un_Zone` (1-based; set them in order, the count grows to it) on a conveyor, with the component's CCS on it |
| `m_ClearZones()` | Removes all zones |

All robot FBs (Delta, XTS gantry, XTS loop, Cartesian; `_FB_VisuRobot`):

| Method | Purpose |
| --- | --- |
| `m_SetFinger(vi_un_Finger, vi_lr_Diameter, vi_lr_Height)` | Defines finger `vi_un_Finger` (1-based) of the gripper (for XTS kinematics: of every mover's gripper); the finger count grows to it |
| `m_ClearFingers()` | Removes the gripper definition |

Both XTS FBs (XTS gantry, XTS loop; `_FB_VisuXtsTrack`):

| Method | Purpose |
| --- | --- |
| `m_SetModule(vi_un_Module, vi_e_Kind, vi_lr_Length := VISU_GlobalConst.VISU_lr_XTS_MODULE_LENGTH)` | Sets track module `vi_un_Module` (1-based, in the order the movers run; set them in order, the count grows to it) |
| `m_ClearModules()` | Removes all track modules |
| `m_SetModuleFault(vi_un_Module, vi_b_Fault, vi_str_FaultMessage := '')` | Reports a module's fault; call every cycle with its current state |
| `m_TrackLength()` | Length of the track along its modules, mm: the range of track positions (on a loop its perimeter) |

All detector FBs (vision system, product sensor; `_FB_VisuDetector`). `m_Register`, called every cycle, also stamps
the detector's state.

| Method | Purpose |
| --- | --- |
| `m_SetBody(vi_un_Body, vi_e_Shape, vi_e_Role, vi_Pose, vi_lr_Length, vi_lr_Width, vi_lr_Height, vi_lr_TopLength := 0, vi_lr_TopWidth := 0)` | Describes body `vi_un_Body` (1-based) the detector is drawn from; `m_Configure` sets the first ones, more may be added (e.g. a bracket) |
| `m_ClearBodies()` | Removes all bodies, also those `m_Configure` described |
| `m_SetBodyActive(vi_un_Body, vi_b_Active)` | Lights a beam or field of view up while TRUE |

`_FB_VisuVision`:

| Method | Purpose |
| --- | --- |
| `m_Configure(vi_Pose, vi_lr_FieldLength, vi_lr_FieldWidth, vi_lr_WorkingDistance)` | Lens pose (looking along its local −Z); bodies 1 to 3: housing, lens, field of view down to the working distance |

`_FB_VisuSensor`:

| Method | Purpose |
| --- | --- |
| `m_Configure(vi_Pose, vi_lr_BeamLength)` | Head pose; body 1 the head, body 2 the beam along the local +Y |
| `m_SetSignal(vi_b_Signal)` | The beam lights up while TRUE (body 2); call once per cycle |

`_FB_VisuConveyor`:

| Method | Purpose |
| --- | --- |
| `m_Configure(vi_Pose, vi_lr_Length, vi_lr_Width)` | Pose of the belt start and size |
| `m_SetProductType(vi_udn_Id, vi_lr_Length, vi_lr_Width, vi_lr_Height, vi_e_Shape := BOX, vi_lr_CornerRadius := 0)` | Adds or updates a product type: a box, a cylinder (length and width are its diameters along and across the conveying direction: equal for round, different for oval products) or a box with rounded vertical edges (pouches, flow packs) |
| `m_SetBeltPosition(vi_lr_Position)` | Belt position (continuous, mm) and state timestamp; call once per cycle |
| `m_SetModuloBeltPosition(vi_lr_ModuloPosition, vi_lr_ModuloPeriod, vi_b_Reset)` | Same for a modulo axis; unwraps to a continuous position |
| `m_LatchProduct(vi_udn_Id, vi_LatchPose, vi_udn_ProductType, vi_e_State := DETECTED, vi_udn_RobotId := 0, vi_udn_DetectorId := 0)` | Adds a product at the current belt position (or at `vi_lr_LatchBeltPosition` with `vi_b_UseLatchBeltPosition`): `DETECTED` where it arrives, with the detector that saw it; `PLACED` with the robot's id where a robot puts it down |
| `m_SetProductState(vi_udn_Id, vi_e_State, vi_udn_RobotId, vi_udn_MoverId := 0, vi_udn_FingerId := 0)` | Changes state, assigned robot, carrying mover and finger |
| `m_MoveProduct(vi_udn_Id, vi_Pose)` | Puts a product at a new MCS pose at the current belt position, keeping its state, e.g. while a mover pushes it along the belt |
| `m_RemoveProduct(vi_udn_Id)` | Removes one product, e.g. once a robot has put it down on another conveyor |
| `m_RemoveProductsBeyond(vi_lr_BeltX)` | Drops invalid entries and products beyond `vi_lr_BeltX` mm along the belt; keeps ASSIGNED and PICKED ones |
| `m_ProductCount()`, `m_GetProduct(vi_un_Index, vo_Product =>, vo_Pose =>)`, `m_FindProduct(vi_udn_Id)` | Read the register; `vo_Pose` is the product's current MCS pose |
| `m_BeltPosition()` | Belt position last set |

`_FB_VisuDelta`:

| Method | Purpose |
| --- | --- |
| `m_Configure(vi_Pose, vi_lr_BaseRadius, vi_lr_EffectorRadius, vi_lr_UpperArmLength, vi_lr_LowerArmLength)` | Base pose and geometry |
| `m_SetWorkingArea(vi_lr_Radius, vi_lr_ZMin, vi_lr_ZMax, vi_lr_ConeHeight, vi_lr_ConeBottomRadius)` | Working area |
| `m_SetLimitArea(vi_lr_XMin, vi_lr_XMax, vi_lr_YMin, vi_lr_YMax, vi_lr_ZMin, vi_lr_ZMax)`, `m_ClearLimitArea()` | Sets and activates / removes the limit area |
| `m_SetTcp(vi_ActualTcp, vi_SetpointTcp)` | Reports the TCP (positions) and the state timestamp; call once per cycle |
| `m_SetFingerState(vi_un_Finger, vi_Pose, vi_b_Active)` | Reports one finger's MCS pose and grip state; call once per cycle per finger |
| `m_BasePose()` | Base pose last configured |

`_FB_VisuXtsGantry`:

| Method | Purpose |
| --- | --- |
| `m_Configure(vi_Pose, vi_lr_XMin, vi_lr_XMax, vi_lr_ZMin, vi_lr_ZMax, vi_lr_ToolOffsetX, vi_lr_ToolOffsetZ, vi_lr_MoverLength, vi_lr_MoverWidth)` | Pose, strokes, gripper offsets, mover size; the track from `m_SetModule` |
| `m_SetZPosition(vi_lr_Z)` | Common Z axis and state timestamp; call once per cycle |
| `m_SetMoverCount(vi_un_Count)` | Number of mover entries evaluated; entries beyond are invalidated |
| `m_SetMover(vi_un_Index, vi_udn_Id, vi_lr_Position, vi_lr_X, vi_b_GripperActive, vi_FingerStates, vi_b_Fault := FALSE, vi_str_FaultMessage := '')` | One mover's actual values, finger states and fault |

`_FB_VisuXtsLoop`:

| Method | Purpose |
| --- | --- |
| `m_Configure(vi_Pose, vi_lr_ToolOffset, vi_lr_MoverLength, vi_lr_MoverWidth)` | Pose, tool offset, mover size; the track from `m_SetModule` |
| `m_SetMoverCount(vi_un_Count)` | Number of mover entries evaluated; entries beyond are invalidated |
| `m_SetMover(vi_un_Index, vi_udn_Id, vi_lr_Position, vi_FingerStates, vi_b_Fault := FALSE, vi_str_FaultMessage := '')` | One mover's position along the loop, finger states and fault |

`_FB_VisuCartesian`:

| Method | Purpose |
| --- | --- |
| `m_Configure(vi_Pose, vi_lr_XMin, vi_lr_XMax, vi_lr_YMin, vi_lr_YMax, vi_lr_ZMin, vi_lr_ZMax, vi_lr_RailHeight)` | Pose, strokes, rail height |
| `m_SetAxes(vi_lr_X, vi_lr_Y, vi_lr_Z, vi_b_GripperActive := FALSE)` | Actual axis values (the flange), gripper and state timestamp; call once per cycle |
| `m_SetFingerState(vi_un_Finger, vi_Pose, vi_b_Active)` | As for the Delta |

## Using it in an application

The manifest is **declared by the application**, not the library (ADR-0003). That keeps the ADS symbol path the gateway
reads independent of the library's namespace. The gateway expects `GVL_Visu.stManifest`; an application that declares
the manifest elsewhere sets the gateway option `manifestPath` to that symbol path. Component instances can live anywhere; the
symbol path of their `vo_Visu` goes into the manifest.

```st
{attribute 'qualified_only'}
VAR_GLOBAL
	(* GVL_Visu (application project) *)
	stManifest							: SynVisu.ST_VisuManifest;
END_VAR
```

```st
PROGRAM MAIN
VAR
	fb_Infeed							: SynVisu._FB_VisuConveyor;
	fb_Delta1							: SynVisu._FB_VisuDelta;
	fb_Vision1							: SynVisu._FB_VisuVision;
END_VAR

fb_Infeed.m_Register(vio_Manifest := GVL_Visu.stManifest, vi_udn_Id := 1, vi_str_Name := 'Infeed',
	vi_str_Path := 'MAIN.fb_Infeed.vo_Visu');
fb_Delta1.m_Register(vio_Manifest := GVL_Visu.stManifest, vi_udn_Id := 10, vi_str_Name := 'Delta 1',
	vi_str_Path := 'MAIN.fb_Delta1.vo_Visu');
fb_Vision1.m_Register(vio_Manifest := GVL_Visu.stManifest, vi_udn_Id := 50, vi_str_Name := 'Vision 1',
	vi_str_Path := 'MAIN.fb_Vision1.vo_Visu');

fb_Infeed.m_Configure(vi_Pose := InfeedPose, vi_lr_Length := 5000, vi_lr_Width := 400);
fb_Infeed.m_SetProductType(vi_udn_Id := 1, vi_lr_Length := 120, vi_lr_Width := 80, vi_lr_Height := 40);
fb_Infeed.m_SetProductType(vi_udn_Id := 2, vi_lr_Length := 90, vi_lr_Width := 90, vi_lr_Height := 60,
	vi_e_Shape := E_VisuProductShape.CYLINDER);
fb_Infeed.m_SetModuloBeltPosition(vi_lr_ModuloPosition := <axis modulo position>, vi_lr_ModuloPeriod := <modulo period>,
	vi_b_Reset := FALSE);
(* The lens 800 mm above the belt; the vision system sees 400 x 300 mm from 800 to 1200 mm along the belt. *)
fb_Vision1.m_Configure(vi_Pose := LensPose, vi_lr_FieldLength := 400, vi_lr_FieldWidth := 300,
	vi_lr_WorkingDistance := 800);
fb_Vision1.m_SetZone(vi_un_Zone := 1, vi_udn_ConveyorId := fb_Infeed.m_Id(), vi_lr_Start := 800, vi_lr_End := 1200,
	vi_lr_CcsOffset := 1000);
IF b_Latched THEN
	fb_Infeed.m_LatchProduct(vi_udn_Id := udn_NextId, vi_LatchPose := LatchPose, vi_udn_ProductType := 1,
		vi_udn_DetectorId := fb_Vision1.m_Id());
END_IF

fb_Delta1.m_Configure(vi_Pose := DeltaBase, vi_lr_BaseRadius := 200, vi_lr_EffectorRadius := 50,
	vi_lr_UpperArmLength := 400, vi_lr_LowerArmLength := 1000);
fb_Delta1.m_SetFinger(vi_un_Finger := 1, vi_lr_Diameter := 40, vi_lr_Height := 50);
fb_Delta1.m_SetLimitArea(vi_lr_XMin := -500, vi_lr_XMax := 500, vi_lr_YMin := -750, vi_lr_YMax := 750,
	vi_lr_ZMin := -1500, vi_lr_ZMax := -700);
fb_Delta1.m_SetZone(vi_un_Zone := 1, vi_udn_ConveyorId := fb_Infeed.m_Id(), vi_lr_Start := 1100, vi_lr_End := 1900,
	vi_lr_AllocationOffset := 300);
fb_Delta1.m_SetTcp(vi_ActualTcp := Tcp, vi_SetpointTcp := TcpSetpoint);
(* The cup below the flange, turned by the 4th axis: absolute in the MCS. *)
CupPose.fX := Tcp.fX; CupPose.fY := Tcp.fY; CupPose.fZ := Tcp.fZ; CupPose.fRz := lr_Axis4;
fb_Delta1.m_SetFingerState(vi_un_Finger := 1, vi_Pose := CupPose, vi_b_Active := b_Vacuum);
```

The demo project `plc/Syn_Visu_Demo` is a complete example, one program per application, including two XTS loops (one above two belts, one under a belt that spaces products evenly), an XTS gantry and a Cartesian robot,
three Delta grippers: two cups beside the flange turning about Rz (two picks, one place), one finger turning and
tilting, and five fingers closing when picking and opening when placing, and a vision system and a light barrier on the
Delta infeeds.

## Discovery

The gateway reads `GVL_Visu.stManifest` and refuses to continue when `nProtocolVersion` differs from its own; it keeps
watching the version and recovers as soon as it matches. For each
of the first `nCount` entries it checks that the symbol at `sPath` has the data type `ST_VisuConveyor`, `ST_VisuDelta`,
`ST_VisuXtsGantry`, `ST_VisuXtsLoop`, `ST_VisuCartesian` or `ST_VisuDetector` (vision system and product sensor)
according to `eType`. Names qualified with the library namespace, such as `SynVisu.ST_VisuDelta`, are accepted too.
It then reads `<sPath>.stConfig` once. Every cycle it sum-reads `GVL_Visu.stManifest.nProtocolVersion`,
`GVL_Visu.stManifest.nConfigVersion` and all `<sPath>.stState`, and rediscovers when either version changes.

Since library 5.1.0 the manifest's last member `sLibraryVersion` (`STRING(15)`, e.g. `5.1.0`) names the library the
PLC runs. The gateway passes it on in the `config` message and at `/health`, and the web app shows it in the status
bar; it also appears in the protocol version error. Older libraries do not have the member, which the gateway
accepts, so the protocol version stays 12.

## Enumerations

| Enum | Values |
| --- | --- |
| `E_VisuComponentType` (UINT) | `NONE` 0, `CONVEYOR` 1, `DELTA` 2, `XTS_GANTRY` 3, `XTS_LOOP` 4, `CARTESIAN` 5, `VISION` 6, `SENSOR` 7 |
| `E_VisuProductState` (UINT) | `DETECTED` 0, `ASSIGNED` 1, `PICKED` 2, `REJECTED` 3, `PLACED` 4 |
| `E_VisuProductShape` (UINT) | `BOX` 0, `CYLINDER` 1, `ROUNDED_BOX` 2 |
| `E_VisuBodyShape` (UINT) | `BOX` 0, `CYLINDER` 1, `FRUSTUM` 2 |
| `E_VisuBodyRole` (UINT) | `STRUCTURE` 0, `SENSOR` 1, `BEAM` 2, `FIELD_OF_VIEW` 3 |
| `E_VisuModuleKind` (UINT) | `STRAIGHT` 0, `CURVE_LEFT` 1, `CURVE_RIGHT` 2 |

Values are part of the contract: append, never renumber. The gateway reads a value as the index of the protocol's
option, so they count from 0 without gaps.

A product a robot puts down onto a conveyor enters that conveyor's register as `PLACED` (an outfeed, a tray belt), e.g.
`m_LatchProduct(..., vi_e_State := E_VisuProductState.PLACED, vi_udn_RobotId := fb_Robot.m_Id())`.
The visualisation flags every product that passes its belt end in `DETECTED` or `ASSIGNED` as missed; `PLACED` and
`REJECTED` products pass the end on purpose.

`PLACED` means the product lies on the conveyor whose register holds it: the visualisation draws it there like a
detected product. While a robot holds a product it stays `PICKED` in the register it was picked from (a placeholder
travels on that belt); once the robot puts it down on another conveyor, the PLC removes it from that register
(`m_RemoveProduct(vi_udn_Id)`) and latches it on the other one as `PLACED`. A product put back onto the same belt
(e.g. by a spacing loop) changes to `PLACED` in place.
