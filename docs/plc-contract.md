# PLC contract (library `Syn_Visu`, protocol version 22)

This is the PLC side of the contract the gateway reads. It is implemented by the TwinCAT library project in
`plc/Syn_Visu` (solution `plc/RPP_Visu.sln`). The TypeScript mirror is `apps/gateway/src/plc-contract.ts`,
and the gateway maps it to the neutral model in `packages/protocol`. Change all three together, and bump
`VISU_GlobalConst.VISU_un_PROTOCOL_VERSION` / `PROTOCOL_VERSION` on any breaking change. Adding a component type:
`docs/adding-a-component.md`. How to use the library in a machine project, task by task, with the reference of every method: `docs/plc-library-guide.md`
(served by the gateway at `/docs`, ADR 0014).

The library follows the company guideline in `docs/plc-coding-guidelines.md` (`_FB_`, `m_`, `vi_`/`vo_`/`vio_`
prefixes) except for the contract itself: the structures, their members, the enums and `GVL_Visu.stManifest` keep
their Beckhoff-style names, because the gateway reads them.

## Layout in the repo

| Path | Content |
| --- | --- |
| `plc/RPP_Visu.sln` | TwinCAT solution with both PLC projects |
| `plc/Syn_Visu/` | The library project: structures, enums, constants and the component function blocks. No task, no application code. |
| `plc/Syn_Visu_Demo/` | The demo application. It references the installed library like any machine project, so it also tests the library from the outside. ADS port 852. `PlcTask` calls `P_VisuDemo`, which sets the shared cycle time and fault phase (`DEMO_GlobalVar`) and calls one program per application: `P_VisuDemoDelta`, `P_VisuDemoFxx`, `P_VisuDemoIdh`, `P_VisuDemoCartesian`, `P_VisuDemoCartesianAxes` (a Cartesian robot without Y axis and one without Z axis, `m_SetKinematics`), `P_VisuDemoSpacing`, and the load test `P_VisuDemoStress` (off unless `DEMO_GlobalVar.DEMO_un_StressProducts` is set; `docs/performance.md`). Shared constants (belt height and width, product, suction cup, fault timing) are in `DEMO_GlobalConst`, the manifest and the machine entry in `GVL_Visu`; `P_VisuDemo` reports the machine (running, simulation mode, the machine message "Reject bin almost full" about the reject unit for 4 s of every fault period). |
| `plc/library/Syn_Visu_<version>.library` | The exported library with its source, committed for every released version. |
| `plc/library/Syn_Visu_<version>.compiled-library` | The same version compiled, without source code. `pnpm package` puts the newest one into the deployment package (`plc/`); machine projects install it from there. |

Releasing a version: bump `_FC_GetVersionSynVisu`, `VISU_GlobalConst.VISU_str_LIBRARY_VERSION` and the project
version (Properties → Common), build, export it with
"Save as library and install" to `plc/library/Syn_Visu_<version>.library` and with "Save as compiled library" to
`plc/library/Syn_Visu_<version>.compiled-library`, update the demo's reference and build again.
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
- A structure for a value that may be absent (a fault, a robot's limit area) has a `bActive` member: FALSE means
  none.
- An enumeration's value is the index of the protocol's option (`E_VisuProductShape.CYLINDER` = 1 = `"cylinder"`).
- Live states of the config's lists sit in `aFingerStates` and `aBodyStates`; the gateway keeps as many as the config
  has (also per mover).
- `nTimestamp` (ULINT) becomes a decimal string.

## Conventions

- MCS: mm and degrees, right-handed, Z up, X in product flow direction.
- Pose rotation order: R = Rz(fRz) · Ry(fRy) · Rx(fRx).
- `nTimestamp`: distributed-clock time in ns since 2000-01-01 of the cycle that wrote the state. The component FBs set it.
- Cross-references (`nLastClientId`, `nConveyorId`) use manifest `nId` values, never symbol paths; `nMoverId` uses the mover ids an XTS gantry or loop reports.
- Client: a component that works on the products of a conveyor: a robot, a detector or a station. A product names the
  client that made its last change (`nLastClientId`) and keeps the state before that change (`ePreviousState`):
  the detector or station that latched it (`m_LatchProduct(..., vi_udn_ClientId)`), the robot it is assigned to,
  picked by, placed by or released by, the station that rejected it (`m_SetProductState(..., vi_udn_ClientId)`). The
  product history and the metrics count from these what each client did (detected, picked, placed, rejected).
  `ePreviousState` equals `eState` until the first change after the latch; setting the same state again keeps it.
- Fault: every component state, every XTS mover and every track module (`aModuleStates[i]`) carries `stFault : ST_VisuFault` (`bActive`, `sMessage` STRING(80)). While `bActive` is TRUE the visualisation draws the component, or only that mover or module, red and shows `sMessage` ("Fault" if empty) above it, in the component list, in the inspector and as a mark on the recording's timeline. There is one fault per component, mover or module at a time and no severity. Faults are live state: they are read every cycle and not interpolated.
- `fBeltPosition` is a continuous position in mm (no modulo). For modulo axes use `_FB_VisuConveyor.m_SetModuloBeltPosition`.
- Conveyor body: `bBody` (default TRUE, `m_SetBodyVisible`) draws the belt as a body. FALSE is a conveyor without
  one (e.g. products pushed by movers, a virtual queue): only its products, zones and axis are drawn, and its belt
  corners are no snap points. Every conveyor shows its X axis on the belt surface in violet: a small ball at its shifted
  origin, a line along the belt and the conveying direction arrow at the belt end; the ball selects the conveyor.
- Product latch pose = bottom centre of the product when it was latched, **in the conveyor's
  coordinate system**: from the conveyor's `stPose` moved by its `stOriginShift`, `fX` along the conveying direction,
  `fY` across the belt, `fZ` up (0 on the belt surface), `fRz` from the belt's X axis. The visualisation moves the
  product from there along the belt by `fBeltPosition − fLatchBeltPosition`, keeping its height.
- Product mark: `nMark` (UINT) singles a product out, 1 to `VISU_un_MAX_MARKS` (4); 0 = none. The application sets
  it (`m_SetProductMark`); it stays through state changes and `m_MoveProduct` and starts at 0 on `m_LatchProduct`. A
  marked product is drawn in its mark's colour instead of its state colour (layer "Product marks"); the manifest's
  `aMarkNames` say what each mark means.
- Stacked products: a product lying on another has `fZ` = the height of the one below (their sum for a higher stack)
  and is an entry of its own, travelling with the belt like the others. The visualisation knows no stack: when the
  product below is picked or removed, the one above stays at its height until the application moves it
  (`m_MoveProduct` with `fZ := 0`) or removes it. The application converts MCS positions (e.g. a finger's pose when
  placing) into these coordinates itself.
- Delta: the PLC reports only the **TCP** (effector centre, the gripper flange) as a position in the MCS. The
  visualisation derives the arm posture by inverse kinematics from the configured geometry: arm 1 lies along the
  base's local +X, arms 2 and 3 follow counter-clockwise (seen from above) at 120°; 0° = upper arm horizontal,
  positive = downward. The effector stays turned with the base; a 4th axis shows only through the finger poses. The TCP's
  axis triad and the flange frame keep the MCS axes, however the robot is mounted.
- Limit area (Delta, XTS gantry, Cartesian robot; not the XTS loop): an optional axis-aligned box in the robot frame
  (relative to its `stPose`, turned with it: the frame its working area is given in, the base centre of a Delta, the
  gantry's track start, the Cartesian robot's axis zero) that further restricts the working area, e.g. so that
  neighbouring robots cannot collide. It is drawn only while `stLimitArea.bActive` is TRUE; equal bounds make a flat
  box. `_FB_VisuRobot` sets it for all three through `m_LimitArea`, which tells it where `stLimitArea` lies.
- TCP limit area (Delta, XTS gantry, Cartesian robot; not the XTS loop): an optional axis-aligned box around the TCP
  (the Delta's TCP, the Cartesian robot's flange, every XTS gantry mover's gripper flange), its bounds relative to
  the TCP along the axes of the robot frame. It moves with the TCP and never turns. Same structure
  (`ST_VisuLimitArea`, `stTcpLimitArea`), drawn only while `bActive` is TRUE; `_FB_VisuRobot.m_SetTcpLimitArea` sets
  it, `m_LimitArea` tells it where `stTcpLimitArea` lies. The PLC reports no violation: the visualisation finds one
  where a TCP limit area overlaps another robot's limit area or another TCP limit area (also another mover's of the
  same gantry), or leaves its own robot's limit area, and lights up both boxes with a message (ADR 0015).
- Zone: a stretch of a conveyor that belongs to a component, set with `m_SetZone(vi_un_Zone, ...)` (1-based, in
  order): where a robot picks or places, where a detector detects. What the component does there is its own business;
  the visualisation draws every zone alike. `fStart = fEnd` is a line across the belt, e.g. for a light barrier.
- Zone allocation: `fAllocationOffset` is the distance in mm before `fEnd`, against the conveying direction, up to
  which a robot may still allocate products in the zone, so it does not move out of the zone while approaching. The
  allocation area runs from `fStart` to `fEnd − fAllocationOffset` (never beyond `fStart`); 0 = no allocation limit.
- Zone CCS: `fCcsOffset` is the belt coordinate (like `fStart` / `fEnd`) of the component's conveyor coordinate system
  (CCS) on that conveyor. It is drawn as a white dashed line across the zone, above every other zone overlay (also
  where it meets the allocation limit), in the zones layer, and is a measure-mode snap point. The CCS may lie outside
  its zone, but must lie on the belt (between its start and end); else the visualisation warns and draws it there.
- Zone along the belt: a zone reaching past the belt start or end is drawn as reported and raises a warning.
- Zone across the belt: `fStartY` and `fEndY` are the zone's sides across the belt, mm along the conveyor's local Y
  from its origin shift (the conveyor's coordinate system, like a product's latch pose), in any order.
  `fStartY = fEndY` (e.g. both 0) spans the whole belt width. A zone may reach past the belt's sides: it is drawn
  as reported, without a warning. Area, allocation area, CCS line and snap points lie between the two sides.
- Origin shift: every config has `stOriginShift : ST_VisuPosition`, mm in the component's local frame from `stPose`
  (no rotation), where the component's coordinate system lies; 0 = at the pose. The origin triad and the local
  measuring coordinates are shown from there. For a conveyor the belt coordinates also count from it: a zone's
  `fStart`, `fEnd` and `fCcsOffset` are measured along the belt from `stOriginShift.fX` (its Y and Z move only the
  shown origin). For robots only the shown origin moves; geometry, working and limit area, axis values and mover
  positions stay relative to `stPose`. MCS values (finger poses, TCP) are not affected; product latch poses count
  from a conveyor's shifted origin like its belt coordinates.
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
  box is the flange volume. `eAxes` (`E_VisuCartesianAxes`) may leave out an axis: `XZ` has no Y axis, a fixed beam
  along local X at `fRailHeight` replaces rails and bridge and Y is always 0 (`fYMin`, `fYMax` and `fY` are ignored);
  `XY` has no Z axis, the column has a fixed length and the flange stays at `fZMin` (`fZMax` and `fZ` are ignored).
  The working area is then a flat rectangle.
- Components drawn from bodies (detectors and stations, `_FB_VisuBodyComponent`): drawn only from the bodies they
  describe (`aBodies`, at most `VISU_GlobalConst_Param.VISU_un_MAX_BODIES`): a box, a cylinder (length and width are
  its diameters) or a frustum (bottom `fLength` × `fWidth`, top `fTopLength` × `fTopWidth`), standing on its bottom
  centre `stPose` in the component's frame and extending along its local +Z. Its role sets the look: `STRUCTURE` and
  `SENSOR` are machine parts (a sensor part in its own colour) that turn the active colour while
  `aBodyStates[i].bActive`; `BEAM` and `FIELD_OF_VIEW` are overlays on the zones layer that light up while active.
  The visualisation has no code of its own for them (ADR 0007).
- Detector (vision system, product sensor): it detects products in its zones; the application latches them on the
  conveyor itself with `m_LatchProduct(..., vi_udn_ClientId := fb_Detector.m_Id())`. A vision system's pose is its
  lens, looking along its local −Z; a sensor's pose is its head, its beam along the local +Y.
- Station (`ST_VisuStation`, `_FB_VisuStation`): a client at a conveyor that works on the products in its zones, e.g.
  a reject unit, a labeller, a printer or a check weigher. Its pose is its origin; the application describes all of
  its bodies with `m_SetBody` and lights a body while it works (`m_SetBodyActive`, e.g. a pusher). It changes
  products on the conveyor itself, e.g. `m_SetProductState(..., REJECTED, vi_udn_ClientId := fb_Station.m_Id())`, and
  may latch them like a detector.
- Gripper: every kinematics may define fingers (`nFingerCount`, `aFingers`, at most `VISU_GlobalConst_Param.VISU_un_MAX_FINGERS`),
  always drawn as cylinders (`fDiameter`, `fHeight`), each with its place on the gripper flange (`stOffset`,
  `ST_VisuPlanarPose`: position in the flange frame and rotation about its Z; ADR 0018). The flange frame's −Z points
  to the product: a Delta's lies at the TCP with the robot's axes, a Cartesian robot's has the robot's axes, an XTS
  mover's turns with the mover. The PLC reports each finger's pose every cycle, **absolute in the MCS**
  (`aFingerStates[i].stPose`, per mover for XTS kinematics), and whether it grips (`bActive`); `bPoseReported` says
  whether the application reported the pose. While it is FALSE, clients place the finger by its offset on the flange
  (the library sets it: `m_SetFingerState` marks a finger of a Delta or Cartesian robot as reported, an XTS track's
  `m_SetMover` marks every finger reported unless `m_SetFingersOnFlange(TRUE)`). A finger's frame has its origin at
  the centre of the finger's top face; the finger extends along its local −Z, and its grip point is the centre of its
  bottom face. A thin rod connects each finger to its gripper flange. Without fingers the flange is drawn as a plate
  coloured by `bGripperActive`.
- A product in state PICKED hangs from robot `nLastClientId`, mover `nMoverId` (0 for a robot without movers) and finger
  `nFingerId` (1-based): its top touches the finger's grip point and it takes the finger's full orientation. With
  `nFingerId` = 0 (or an unknown finger, which also raises a warning) it hangs at the gripper flange, turned with the
  robot (a Delta's flange keeps the MCS axes, however the robot is mounted). When placing, set the product's latch pose
  to the finger's grip point in the conveyor's coordinate system and its `fRz` to the finger's MCS rotation about Z
  minus the conveyor's, so it stays turned on the belt.
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
- Protocol version 13 made the product's client generic: `nLastClientId` and `ePreviousState` replace `nRobotId` and
  `nDetectorId` (`vi_udn_ClientId` replaces `vi_udn_RobotId` and `vi_udn_DetectorId` in `m_LatchProduct` and
  `m_SetProductState`), and added the station (`ST_VisuStation`, `E_VisuComponentType.STATION`; ADR 0009).
- Protocol version 14 gives the product's `stLatchPose` in the conveyor's coordinate system instead of the MCS
  (ADR 0010).
- Protocol version 15 added the zones' `fStartY` and `fEndY`: a zone may cover only part of the belt width.
- Protocol version 16 added the conveyor's `bBody`: a conveyor may have no body.
- Protocol version 17 added the Cartesian robot's `eAxes` (`E_VisuCartesianAxes`): X, Y, Z, or without the Y or the Z axis.
- Protocol version 18 added `stLimitArea` to the XTS gantry and the Cartesian robot (before only the Delta had one).
- Protocol version 19 added `stTcpLimitArea`, a box around the TCP, to the Delta, the XTS gantry and the Cartesian
  robot.
- Protocol version 20 added each finger's `stOffset` on the gripper flange and the finger state's `bPoseReported`
  (ADR 0018).
- Protocol version 21 added product marks: the product's `nMark` and the manifest's `aMarkNames`.
- Protocol version 22 added the machine entry `ST_VisuMachine` next to the manifest (ADR 0021): run state, simulation
  mode and machine messages. The gateway still reads protocol 21, which lacks only that.

## What the library contains

The component function blocks, their methods and the enumerations are listed for PLC programmers in the library
guide's reference (`docs/plc-library-guide.md`, section 19), which the gateway serves at `/docs`. Keep that
reference in step with the library. The FBs fill the contract structures below in their output `vo_Visu`;
application code does not write them.

| Structure | Read by the gateway as |
| --- | --- |
| `ST_VisuManifest`, `ST_VisuManifestEntry`, `E_VisuComponentType` | Discovery: which components exist and where (`GVL_Visu.stManifest`, declared by the application, ADR 0003) |
| `ST_VisuMachine`, `ST_VisuMachineMessage`, `E_VisuRunState`, `E_VisuMessageSeverity` | The machine entry: run state, simulation mode and machine messages (`GVL_Visu.stMachine`, declared by the application, set with `_FB_VisuMachine`; protocol 22, ADR 0021) |
| `ST_VisuConveyor` (`stConfig` / `stState`), `ST_VisuProduct`, `ST_VisuProductType` | Conveyor (`_FB_VisuConveyor.vo_Visu`) |
| `ST_VisuDelta`, `ST_VisuWorkingArea`, `ST_VisuLimitArea`, `ST_VisuZone` | Delta (`_FB_VisuDelta.vo_Visu`) |
| `ST_VisuXtsGantry`, `ST_VisuGantryMover` | XTS gantry (`_FB_VisuXtsGantry.vo_Visu`) |
| `ST_VisuXtsLoop`, `ST_VisuLoopMover` | XTS loop (`_FB_VisuXtsLoop.vo_Visu`) |
| `ST_VisuTrackModule`, `ST_VisuTrackModuleState` | One module of an XTS track and its live fault |
| `ST_VisuCartesian` | Cartesian robot (`_FB_VisuCartesian.vo_Visu`) |
| `ST_VisuDetector`, `ST_VisuBody`, `ST_VisuBodyState` | Vision system or product sensor (`_FB_VisuDetector.vo_Visu`) |
| `ST_VisuStation` | Station (`_FB_VisuStation.vo_Visu`); its members are a detector's |
| `ST_VisuFault`, `ST_VisuFinger`, `ST_VisuFingerState` | Faults, gripper fingers and their live poses |
| `ST_VisuPose`, `ST_VisuPlanarPose`, `ST_VisuPosition` | Poses and positions |

The demo project `plc/Syn_Visu_Demo` is a complete example, one program per application, including two XTS loops (one
above two belts, one under a belt that spaces products evenly), an XTS gantry, a Cartesian robot and two Cartesian
robots with two axes (X-Z, X-Y), three Delta grippers: two cups beside the flange turning about Rz (two picks, one
place), one finger turning and tilting, and five fingers closing when picking and opening when placing, a vision
system and a light barrier on the Delta infeeds and a reject unit (station) at the Delta outfeed.

## Discovery

The gateway reads `GVL_Visu.stManifest` and refuses to continue when `nProtocolVersion` is not one it reads (21 or 22);
it keeps watching the version and recovers as soon as it matches. For each
of the first `nCount` entries it checks that the symbol at `sPath` has the data type `ST_VisuConveyor`, `ST_VisuDelta`,
`ST_VisuXtsGantry`, `ST_VisuXtsLoop`, `ST_VisuCartesian`, `ST_VisuDetector` (vision system and product sensor) or
`ST_VisuStation`
according to `eType`. Names qualified with the library namespace, such as `SynVisu.ST_VisuDelta`, are accepted too.
It then reads `<sPath>.stConfig` once. Every cycle it sum-reads `GVL_Visu.stManifest.nProtocolVersion`,
`GVL_Visu.stManifest.nConfigVersion` and all `<sPath>.stState`, and rediscovers when either version changes.

Since library 5.1.0 the manifest's member `sLibraryVersion` (`STRING(15)`, e.g. `5.1.0`) names the library the
PLC runs. The gateway passes it on in the `config` message and at `/health`, and the web app shows it in the status
bar; it also appears in the protocol version error. Libraries 5.0 and older do not have the member, which the gateway
accepts; it came without a protocol change.

Since protocol 21 the manifest's `aMarkNames` (`ARRAY[1..VISU_un_MAX_MARKS] OF STRING(31)`, 4 marks) names the
product marks for the whole PLC: entry n is what mark n means, e.g. `Sample`; an empty entry is an unnamed mark. The
gateway reads it during discovery and passes the named marks on in the `config` message (`marks`), so a new name
needs a config version bump, which the library's function for it does.

## The machine entry (protocol 22)

Next to its manifest the application may declare the machine entry `GVL_Visu.stMachine : ST_VisuMachine` (in the GVL of
the manifest, whatever `--manifest-path` names; ADR 0021). It is not a component: it has no manifest entry, no pose
and no body. With protocol 22 the gateway looks for it during discovery: missing, the application is read as before;
of another type, it is a discovery error. Otherwise the gateway reads it in every cycle's sum-read and publishes it as
a `machine` message whenever it changes.

| Member | Meaning |
| --- | --- |
| `eRunState` (`E_VisuRunState`) | What the machine is doing: stopped, starting, running, stopping, fault |
| `sRunStateText` (STRING(80)) | What the application says about it, e.g. why it is in a fault |
| `bSimulation` | The application runs without real hardware (simulation mode): nothing real moves when it is started |
| `nMessageCount`, `aMessages` | The machine messages, entries `[0..nMessageCount-1]`, `VISU_un_MAX_MACHINE_MESSAGES` (32) at most |

A machine message (`ST_VisuMachineMessage`) has its number `nId` (> 0, unique in the register), `eSeverity`
(`E_VisuMessageSeverity`), `sText` (STRING(80)), `nTime` (DC time in ns when it appeared last), `bActive` (FALSE:
gone, kept until its place is needed) and `nComponentId` (the manifest id of the component it is about, 0 for the
whole machine). The register is read like a product register: as changes by `nId` (ADR 0013). `_FB_VisuMachine` fills
the entry: `m_Register(vio_Machine)`, `m_SetRunState`, `m_SetSimulation` and `m_SetMessage`, which sets a message by its
level like a fault; a message that becomes active gets the current time, and in a full register the gone message that
appeared earliest makes room for a new one.

## Enumerations

| Enum | Values |
| --- | --- |
| `E_VisuComponentType` (UINT) | `NONE` 0, `CONVEYOR` 1, `DELTA` 2, `XTS_GANTRY` 3, `XTS_LOOP` 4, `CARTESIAN` 5, `VISION` 6, `SENSOR` 7, `STATION` 8 |
| `E_VisuProductState` (UINT) | `DETECTED` 0, `ASSIGNED` 1, `PICKED` 2, `REJECTED` 3, `PLACED` 4 |
| `E_VisuProductShape` (UINT) | `BOX` 0, `CYLINDER` 1, `ROUNDED_BOX` 2 |
| `E_VisuBodyShape` (UINT) | `BOX` 0, `CYLINDER` 1, `FRUSTUM` 2 |
| `E_VisuBodyRole` (UINT) | `STRUCTURE` 0, `SENSOR` 1, `BEAM` 2, `FIELD_OF_VIEW` 3 |
| `E_VisuModuleKind` (UINT) | `STRAIGHT` 0, `CURVE_LEFT` 1, `CURVE_RIGHT` 2 |
| `E_VisuCartesianAxes` (UINT) | `XYZ` 0, `XZ` 1 (no Y axis), `XY` 2 (no Z axis) |
| `E_VisuRunState` (UINT) | `STOPPED` 0, `STARTING` 1, `RUNNING` 2, `STOPPING` 3, `FAULT` 4 |
| `E_VisuMessageSeverity` (UINT) | `ERROR` 0, `WARNING` 1, `INFO` 2 |

Values are part of the contract: append, never renumber. The gateway reads a value as the index of the protocol's
option, so they count from 0 without gaps.

A product a robot puts down onto a conveyor enters that conveyor's register as `PLACED` (an outfeed, a tray belt), e.g.
`m_LatchProduct(..., vi_e_State := E_VisuProductState.PLACED, vi_udn_ClientId := fb_Robot.m_Id())`.
The visualisation flags every product that passes its belt end in `DETECTED` or `ASSIGNED` as missed; `PLACED` and
`REJECTED` products pass the end on purpose.

`PLACED` means the product lies on the conveyor whose register holds it: the visualisation draws it there like a
detected product. While a robot holds a product it stays `PICKED` in the register it was picked from (a placeholder
travels on that belt); once the robot puts it down on another conveyor, the PLC removes it from that register
(`m_RemoveProduct(vi_udn_Id)`) and latches it on the other one as `PLACED`. A product put back onto the same belt
(e.g. by a spacing loop) changes to `PLACED` in place.
