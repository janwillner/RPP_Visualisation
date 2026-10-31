# PLC contract (library `Syn_Visu`, protocol version 7)

This is the PLC side of the contract the gateway reads. It is implemented by the TwinCAT library project in
`plc/Syn_Visu` (solution `plc/RPP_Visu.sln`). The TypeScript mirror is `apps/gateway/src/plc-contract.ts`,
and the gateway maps it to the neutral model in `packages/protocol`. Change all three together, and bump
`VISU_GlobalConst.VISU_un_PROTOCOL_VERSION` / `PROTOCOL_VERSION` on any breaking change.

The library follows the company guideline in `docs/plc-coding-guidelines.md` (`_FB_`, `m_`, `vi_`/`vo_`/`vio_`
prefixes) except for the contract itself: the structures, their members, the enums and `GVL_Visu.stManifest` keep
their Beckhoff-style names, because the gateway reads them.

## Conventions

- MCS: mm and degrees, right-handed, Z up, X in product flow direction.
- Pose rotation order: R = Rz(fRz) · Ry(fRy) · Rx(fRx).
- `nTimestamp`: distributed-clock time in ns since 2000-01-01 of the cycle that wrote the state. The component FBs set it.
- Cross-references (`nRobotId`, `nConveyorId`) use manifest `nId` values, never symbol paths; `nMoverId` uses the mover ids an XTS gantry or loop reports.
- `fBeltPosition` is a continuous position in mm (no modulo). For modulo axes use `_FB_VisuConveyor.m_SetModuloBeltPosition`.
- Product latch pose = bottom centre of the product on the belt surface when it was latched.
- Delta: the PLC reports only the **TCP** (effector centre, the gripper flange) as a position in the MCS. The
  visualisation derives the arm posture by inverse kinematics from the configured geometry: arm 1 lies along the
  base's local +X, arms 2 and 3 follow counter-clockwise (seen from above) at 120°; 0° = upper arm horizontal,
  positive = downward. The effector stays turned with the base; a 4th axis shows only through the finger poses.
- Delta limit area: an optional axis-aligned box in the robot frame (relative to the base centre, turned with the
  base pose) that further restricts the working area, e.g. so that neighbouring robots cannot collide. It is drawn
  only while `stLimitArea.bActive` is TRUE.
- Zone allocation: `fAllocationOffset` is the distance in mm before `fEnd`, against the conveying direction, up to
  which a robot may still allocate products in the zone, so it does not move out of the zone while approaching. The
  allocation area runs from `fStart` to `fEnd − fAllocationOffset` (never beyond `fStart`); 0 = no allocation limit.
- XTS gantry (e.g. IDH): local frame at the track start on top of the movers with Z = 0; the track runs along local +Y,
  each mover's X axis along local +X, the common Z axis along local +Z. Gripper flange of a mover in the local frame:
  (X + `fToolOffsetX`, position, Z + `fToolOffsetZ`). Only actual values are reported; a gripper rotation (C) shows
  only through the finger poses.
- XTS loop (e.g. Fxx): local frame at the start of the lower straight, which runs along local +X; the loop stands in the
  local X-Z plane with the upper straight at +2R. Mover positions run from there in the conveying direction over the far
  curve and back along the upper straight (0..2L + 2πR). The curves are drawn as semicircles. A mover's gripper flange (tool
  point) lies `fToolOffset` outwards from the track.
- Cartesian robot: two fixed rails along local +Y with their top at `fRailHeight`, a bridge travelling in Y on them, a
  carriage on the bridge travelling in X and a vertical column (Z) ending at the gripper flange. Local frame: origin at
  axis X = Y = 0, Z up; the flange is at (X, Y, Z). Only actual values are reported; gripper rotations (e.g. C and A)
  show only through the finger poses. The parts are drawn with fixed sizes derived from the strokes; the working-area
  box is the flange volume.
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
| `_FB_VisuComponent` | Abstract base of all: `m_Register`, `m_Id`, config version and DC timestamps |
| `ST_VisuManifest`, `ST_VisuManifestEntry`, `E_VisuComponentType` | Discovery: which components exist and where |
| `ST_VisuConveyor` (`stConfig` / `stState`), `ST_VisuProduct`, `ST_VisuProductType`, `E_VisuProductState` | Conveyor contract structure (`_FB_VisuConveyor.vo_Visu`) |
| `ST_VisuDelta` (`stConfig`: geometry, working area, limit area, zones, fingers / `stState`: actual and setpoint TCP, finger states), `ST_VisuWorkingArea`, `ST_VisuLimitArea`, `ST_VisuZone`, `E_VisuZoneKind` | Delta contract structure (`_FB_VisuDelta.vo_Visu`) |
| `ST_VisuXtsGantry` (`stConfig`: track, strokes, gripper offsets, mover size, zones, fingers / `stState`: Z and movers with finger states), `ST_VisuGantryMover` | XTS gantry contract structure (`_FB_VisuXtsGantry.vo_Visu`) |
| `ST_VisuXtsLoop` (`stConfig`: straight length, curve radius, tool offset, mover size, zones, fingers / `stState`: movers with finger states), `ST_VisuLoopMover` | XTS loop contract structure (`_FB_VisuXtsLoop.vo_Visu`) |
| `ST_VisuCartesian` (`stConfig`: X/Y/Z strokes, rail height, zones, fingers / `stState`: X, Y, Z, gripper, finger states) | Cartesian robot contract structure (`_FB_VisuCartesian.vo_Visu`) |
| `ST_VisuFinger`, `ST_VisuFingerState` | Gripper finger (cylinder size) and its live MCS pose and grip state |
| `ST_VisuPose`, `ST_VisuPlanarPose`, `ST_VisuPosition` | MCS poses and positions |
| `VISU_GlobalConst` | `VISU_un_PROTOCOL_VERSION` (contract version; `ST_VisuManifest` initialises to it), `VISU_lr_DEG_TO_RAD` |
| `VISU_GlobalConst_Param` | Array sizes: `VISU_un_MAX_MANIFEST_ENTRIES` (32), `VISU_un_MAX_PRODUCTS` (128), `VISU_un_MAX_PRODUCT_TYPES` (8), `VISU_un_MAX_ZONES` (8), `VISU_un_MAX_MOVERS` (40), `VISU_un_MAX_FINGERS` (8, per gripper) |
| `_FC_GetVersionSynVisu` | Library version at runtime (3.0.0) |

### Methods

Input names carry the guideline prefixes: `vi_` plus the type (`udn_` UDINT, `un_` UINT, `lr_` LREAL, `b_` BOOL,
`str_` STRING, `e_` enum, none for structures), `vio_` for in-outs, `vo_` for outputs.

All component FBs:

| Method | Purpose |
| --- | --- |
| `m_Register(vio_Manifest, vi_udn_Id, vi_str_Name, vi_str_Path)` | Adds the component to the manifest (bumps `nConfigVersion` when new). `vi_str_Path` is the symbol path of the instance's `vo_Visu`. Idempotent: call it every cycle, which also keeps `nProtocolVersion` current and the manifest reference valid after an online change |
| `m_Id()` | Manifest id given to `m_Register`, 0 before |

All configuration methods may be called every cycle: they bump `nConfigVersion` only when a value actually changes,
and return TRUE in that case.

All robot FBs (Delta, XTS gantry, XTS loop, Cartesian):

| Method | Purpose |
| --- | --- |
| `m_SetFinger(vi_un_Finger, vi_lr_Diameter, vi_lr_Height)` | Defines finger `vi_un_Finger` (1-based) of the gripper (for XTS kinematics: of every mover's gripper); the finger count grows to it |
| `m_ClearFingers()` | Removes the gripper definition |
| `m_SetZone(vi_udn_ConveyorId, vi_e_Kind, vi_lr_Start, vi_lr_End, vi_lr_AllocationOffset := 0)` | Adds or updates the pick or place zone for a conveyor |
| `m_ClearZones()` | Removes all zones |

`_FB_VisuConveyor`:

| Method | Purpose |
| --- | --- |
| `m_Configure(vi_Pose, vi_lr_Length, vi_lr_Width)` | Pose of the belt start and size |
| `m_SetProductType(vi_udn_Id, vi_lr_Length, vi_lr_Width, vi_lr_Height)` | Adds or updates a product type |
| `m_SetBeltPosition(vi_lr_Position)` | Belt position (continuous, mm) and state timestamp; call once per cycle |
| `m_SetModuloBeltPosition(vi_lr_ModuloPosition, vi_lr_ModuloPeriod, vi_b_Reset)` | Same for a modulo axis; unwraps to a continuous position |
| `m_LatchProduct(vi_udn_Id, vi_LatchPose, vi_udn_ProductType)` | Adds a detected product at the current belt position (or at `vi_lr_LatchBeltPosition` with `vi_b_UseLatchBeltPosition`) |
| `m_SetProductState(vi_udn_Id, vi_e_State, vi_udn_RobotId, vi_udn_MoverId := 0, vi_udn_FingerId := 0)` | Changes state, assigned robot, carrying mover and finger |
| `m_RemoveProduct(vi_udn_Id)` | Removes one product |
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
| `m_Configure(vi_Pose, vi_un_ModuleCount, vi_lr_ModuleLength, vi_lr_XMin, vi_lr_XMax, vi_lr_ZMin, vi_lr_ZMax, vi_lr_ToolOffsetX, vi_lr_ToolOffsetZ, vi_lr_MoverLength, vi_lr_MoverWidth)` | Pose, track, strokes, gripper offsets, mover size |
| `m_SetZPosition(vi_lr_Z)` | Common Z axis and state timestamp; call once per cycle |
| `m_SetMoverCount(vi_un_Count)` | Number of mover entries evaluated; entries beyond are invalidated |
| `m_SetMover(vi_un_Index, vi_udn_Id, vi_lr_Position, vi_lr_X, vi_b_GripperActive, vi_FingerStates)` | One mover's actual values and finger states |

`_FB_VisuXtsLoop`:

| Method | Purpose |
| --- | --- |
| `m_Configure(vi_Pose, vi_lr_StraightLength, vi_lr_CurveRadius, vi_lr_ToolOffset, vi_lr_MoverLength, vi_lr_MoverWidth)` | Pose, track geometry, tool offset, mover size |
| `m_SetMoverCount(vi_un_Count)` | Number of mover entries evaluated; entries beyond are invalidated |
| `m_SetMover(vi_un_Index, vi_udn_Id, vi_lr_Position, vi_FingerStates)` | One mover's position along the loop and finger states |
| `m_Perimeter()` | Loop length as the visualisation computes it, mm |

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
	stManifest							: Syn_Visu.ST_VisuManifest;
END_VAR
```

```st
PROGRAM MAIN
VAR
	fb_Infeed							: Syn_Visu._FB_VisuConveyor;
	fb_Delta1							: Syn_Visu._FB_VisuDelta;
END_VAR

fb_Infeed.m_Register(vio_Manifest := GVL_Visu.stManifest, vi_udn_Id := 1, vi_str_Name := 'Infeed',
	vi_str_Path := 'MAIN.fb_Infeed.vo_Visu');
fb_Delta1.m_Register(vio_Manifest := GVL_Visu.stManifest, vi_udn_Id := 10, vi_str_Name := 'Delta 1',
	vi_str_Path := 'MAIN.fb_Delta1.vo_Visu');

fb_Infeed.m_Configure(vi_Pose := InfeedPose, vi_lr_Length := 5000, vi_lr_Width := 400);
fb_Infeed.m_SetProductType(vi_udn_Id := 1, vi_lr_Length := 120, vi_lr_Width := 80, vi_lr_Height := 40);
fb_Infeed.m_SetModuloBeltPosition(vi_lr_ModuloPosition := <axis modulo position>, vi_lr_ModuloPeriod := <modulo period>,
	vi_b_Reset := FALSE);
IF b_Latched THEN
	fb_Infeed.m_LatchProduct(vi_udn_Id := udn_NextId, vi_LatchPose := LatchPose, vi_udn_ProductType := 1);
END_IF

fb_Delta1.m_Configure(vi_Pose := DeltaBase, vi_lr_BaseRadius := 200, vi_lr_EffectorRadius := 50,
	vi_lr_UpperArmLength := 400, vi_lr_LowerArmLength := 1000);
fb_Delta1.m_SetFinger(vi_un_Finger := 1, vi_lr_Diameter := 40, vi_lr_Height := 50);
fb_Delta1.m_SetLimitArea(vi_lr_XMin := -500, vi_lr_XMax := 500, vi_lr_YMin := -750, vi_lr_YMax := 750,
	vi_lr_ZMin := -1500, vi_lr_ZMax := -700);
fb_Delta1.m_SetZone(vi_udn_ConveyorId := fb_Infeed.m_Id(), vi_e_Kind := Syn_Visu.E_VisuZoneKind.PICK,
	vi_lr_Start := 1100, vi_lr_End := 1900, vi_lr_AllocationOffset := 300);
fb_Delta1.m_SetTcp(vi_ActualTcp := Tcp, vi_SetpointTcp := TcpSetpoint);
(* The cup below the flange, turned by the 4th axis: absolute in the MCS. *)
CupPose.fX := Tcp.fX; CupPose.fY := Tcp.fY; CupPose.fZ := Tcp.fZ; CupPose.fRz := lr_Axis4;
fb_Delta1.m_SetFingerState(vi_un_Finger := 1, vi_Pose := CupPose, vi_b_Active := b_Vacuum);
```

`P_VisuDemo` in the library project is a complete example, including an XTS loop, an XTS gantry and a Cartesian robot,
and three Delta grippers: two cups beside the flange turning about Rz (two picks, one place), one finger turning and
tilting, and five fingers closing when picking and opening when placing.

## Discovery

The gateway reads `GVL_Visu.stManifest` and refuses to continue when `nProtocolVersion` differs from its own; it keeps
watching the version and recovers as soon as it matches. For each
of the first `nCount` entries it checks that the symbol at `sPath` has the data type `ST_VisuConveyor`, `ST_VisuDelta`,
`ST_VisuXtsGantry`, `ST_VisuXtsLoop` or `ST_VisuCartesian` according to `eType`. Names qualified with the library namespace, such as `Syn_Visu.ST_VisuDelta`, are accepted too.
It then reads `<sPath>.stConfig` once. Every cycle it sum-reads `GVL_Visu.stManifest.nProtocolVersion`,
`GVL_Visu.stManifest.nConfigVersion` and all `<sPath>.stState`, and rediscovers when either version changes.

## Enumerations

| Enum | Values |
| --- | --- |
| `E_VisuComponentType` (UINT) | `NONE` 0, `CONVEYOR` 1, `DELTA` 2, `XTS_GANTRY` 3, `XTS_LOOP` 4, `CARTESIAN` 5 |
| `E_VisuProductState` (UINT) | `DETECTED` 0, `ASSIGNED` 1, `PICKED` 2, `REJECTED` 3, `PLACED` 4 |
| `E_VisuZoneKind` (UINT) | `PICK` 1, `PLACE` 2 |

Values are part of the contract: append, never renumber.
