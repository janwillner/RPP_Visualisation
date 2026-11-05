# Showing a machine in the visualisation: guide to the PLC library `Syn_Visu`

This guide is for PLC programmers who connect a machine to the web visualisation. It explains, task by task, how
to use the TwinCAT library `Syn_Visu` (installed as `SynVisu`) so that conveyors, products, robots, XTS tracks and
detectors appear in the 3D view and move with the machine.

The method-by-method reference is `docs/plc-contract.md`. The demo project `plc/Syn_Visu_Demo` (solution
`plc/RPP_Visu.sln`) is a complete working example; this guide quotes it where it helps.

Contents:

1. [How it works](#1-how-it-works)
2. [Setting up the project](#2-setting-up-the-project)
3. [The pattern every component follows](#3-the-pattern-every-component-follows)
4. [Coordinates](#4-coordinates)
5. [Conveyors and products](#5-conveyors-and-products)
6. [Zones](#6-zones)
7. [Grippers and fingers](#7-grippers-and-fingers)
8. [Delta robot](#8-delta-robot)
9. [Cartesian robot](#9-cartesian-robot)
10. [XTS tracks and their motor modules](#10-xts-tracks-and-their-motor-modules)
11. [XTS gantry](#11-xts-gantry)
12. [XTS loop](#12-xts-loop)
13. [Vision system, product sensor and station](#13-vision-system-product-sensor-and-station)
14. [Faults](#14-faults)
15. [Wrapping existing machine code](#15-wrapping-existing-machine-code)
16. [Limits](#16-limits)
17. [Checklist before commissioning](#17-checklist-before-commissioning)
18. [Troubleshooting](#18-troubleshooting)

---

## 1. How it works

The visualisation configures itself from what the PLC reports. Nothing about the machine is entered in the web app.

```text
PLC application                         Gateway (on the IPC)                Browser
-----------------                       --------------------                -------
FB instances of SynVisu                 reads over ADS:                     3D view, component tree,
  fill their output vo_Visu   ------>     GVL_Visu.stManifest       ----->  inspector, recording
GVL_Visu.stManifest lists                 every <path>.stConfig (once)
  every instance and its path             every <path>.stState (each cycle)
```

- **Manifest:** One structure, `GVL_Visu.stManifest`, lists every component. Each entry holds an id, a name, a type
  and the symbol path of the component's data.
- **Config:** What does not change while the machine runs: pose, size, product types, zones, track modules. The
  gateway reads it once, and again whenever `nConfigVersion` in the manifest changes.
- **State:** What changes every cycle: belt position, products, TCP, mover positions, faults. The gateway reads all
  states every cycle in one sum read.

You never write these structures yourself. Every component has a function block in the library; you call its
methods, and it fills its output `vo_Visu`, the structure the gateway reads.

## 2. Setting up the project

### 2.1 Install and reference the library

1. Install the released library: `plc\Syn_Visu_<version>.compiled-library` from the deployment package (compiled,
   without source code), or `plc/library/Syn_Visu_<version>.library` from this repository (with source). In XAE:
   PLC → Library Repository → Install. It is installed as **`SynVisu`** from **Syntegon Group**.
2. In your PLC project add a reference: References → Add Library → `SynVisu`. A placeholder reference (newest
   version) is fine.
3. The library's namespace is `SynVisu`. Qualify its objects: `SynVisu._FB_VisuConveyor`, `SynVisu.ST_VisuPose`,
   `SynVisu.E_VisuModuleKind.STRAIGHT`.

### 2.2 Match the gateway

The PLC and the gateway must speak the same protocol version. The gateway refuses a PLC with a different one and
says so in its status.

| Library `SynVisu` | Protocol version | Gateway |
| --- | --- | --- |
| 7.0.x | 14 | releases from protocol 14 on (product poses in the conveyor's coordinate system) |
| 6.0.x | 13 | releases from protocol 13 on (generic product client, station) |
| 5.1.x | 12 | protocol 12; the status bar also shows the library version |
| 5.0.x | 12 | protocol 12 (XTS tracks of motor modules) |
| 4.0.x | 11 | protocol 11 (vision system, product sensor) |

The protocol version is `SynVisu.VISU_GlobalConst.VISU_un_PROTOCOL_VERSION`; the manifest is initialised with it.
The library version is available at runtime from `SynVisu._FC_GetVersionSynVisu(1 | 2 | 3)`.

### 2.3 Declare the manifest

The manifest belongs to your application, not to the library. Create a GVL named **`GVL_Visu`** with one variable
named **`stManifest`**. The gateway reads exactly this symbol path:

```st
{attribute 'qualified_only'}
VAR_GLOBAL
	stManifest							: SynVisu.ST_VisuManifest;	// read by the visualisation gateway
END_VAR
```

If your project must use a different name, set the gateway option `manifestPath` to the symbol path instead.

### 2.4 Where to call it

Call the visualisation code once per cycle, in the task that has the actual values. This is usually the fast task
that also runs the motion, so that TCPs and mover positions are consistent with each other. All component FBs stamp
their state with the distributed-clock time of the cycle that wrote it; the web app interpolates between cycles. The
cost is small: a few method calls per component, no ADS traffic from the PLC side.

## 3. The pattern every component follows

Every component is one FB instance. Each cycle you call, in this order:

1. **Register:** `m_Register(...)` adds the component to the manifest.
2. **Configure:** `m_Configure(...)` and the other configuration methods (`m_SetZone`, `m_SetFinger`,
   `m_SetModule`, ...).
3. **Report:** the state methods (`m_SetBeltPosition`, `m_SetTcp`, `m_SetMover`, ...).

All three may be called every cycle. Registration is idempotent and keeps the manifest valid after an online change.
The configuration methods bump the config version only when a value actually changes; they return TRUE in that case.
So you do not need first-cycle flags.

```st
PROGRAM MAIN
VAR
	fb_Infeed							: SynVisu._FB_VisuConveyor;
	InfeedPose							: SynVisu.ST_VisuPose := (fX := 0, fY := 0, fZ := 800);
END_VAR

(* 1. Register: id, display name, symbol path of this instance's vo_Visu *)
fb_Infeed.m_Register(vio_Manifest := GVL_Visu.stManifest, vi_udn_Id := 1, vi_str_Name := 'Infeed',
	vi_str_Path := 'MAIN.fb_Infeed.vo_Visu');

(* 2. Configure *)
fb_Infeed.m_Configure(vi_Pose := InfeedPose, vi_lr_Length := 3000, vi_lr_Width := 400);
fb_Infeed.m_SetProductType(vi_udn_Id := 1, vi_lr_Length := 120, vi_lr_Width := 80, vi_lr_Height := 40);

(* 3. Report *)
fb_Infeed.m_SetBeltPosition(lr_InfeedBeltPosition);
```

### 3.1 Ids

- Every component needs an id (`vi_udn_Id`) that is unique within the PLC and greater than 0.
- Components refer to each other by these ids: a zone names its conveyor, a product names the client that changed
  it last (robot, detector, station). Use `fb_Other.m_Id()` instead of repeating the number.
- Plan the ids once per machine, e.g. conveyors 1–19, Deltas 10–29, XTS 30–39, detectors 50–59, stations 60–69, and keep them in
  constants. Ids are shown in the component tree and stored in recordings, so do not change them between
  versions of a machine without reason.

### 3.2 The symbol path

`vi_str_Path` is the full symbol path of the instance's output `vo_Visu`, exactly as ADS sees it:

| Where the instance is declared | `vi_str_Path` |
| --- | --- |
| `PROGRAM MAIN`, variable `fb_Infeed` | `'MAIN.fb_Infeed.vo_Visu'` |
| A program `P_Line1`, variable `fb_Delta1` | `'P_Line1.fb_Delta1.vo_Visu'` |
| Inside an FB instance `MAIN.fb_Cell.fb_Robot` | `'MAIN.fb_Cell.fb_Robot.vo_Visu'` |
| In a GVL `GVL_Machine`, variable `fb_Outfeed` | `'GVL_Machine.fb_Outfeed.vo_Visu'` |

A wrong path is the most common mistake: the gateway then reports a discovery error for that component (see
[Troubleshooting](#18-troubleshooting)). Inside your own wrapper FBs, pass the wrapper's path in and append to it
(`CONCAT(vi_str_Path, '.fb_Conveyor.vo_Visu')`, see [section 15](#15-wrapping-existing-machine-code)).

## 4. Coordinates

- **MCS (machine coordinate system):** millimetres and degrees, right-handed, Z up, X in the product flow
  direction. Every pose you pass to `m_Configure` is in the MCS.
- **Poses:** `ST_VisuPose` (`fX`, `fY`, `fZ`, `fRx`, `fRy`, `fRz`). Rotation order R = Rz · Ry · Rx. Most components
  only need `fRz` (turned about the vertical).
- **Local frames:** each component type defines where its pose lies and how its axes run; see its section below.
  A component turned by `fRz := 90` has its local +X along MCS +Y.
- **Belt coordinates:** positions along a conveyor (zones, CCS) are measured along the belt from its start, or from
  its origin shift (below), not in the MCS.
- **Product poses** (latch pose, `m_GetProduct`, `m_MoveProduct`) are in the conveyor's coordinate system: from its
  pose moved by its origin shift, X along the belt, Y across it, Z up from the belt surface, Rz from the belt's X.
- **Absolute values:** finger poses and the Delta's TCP are absolute in the MCS.
- **Origin shift:** `m_SetOriginShift(vi_lr_X, vi_lr_Y, vi_lr_Z)` moves the component's shown coordinate system away
  from its pose (mm in the component's local frame). The origin triad and the local measuring coordinates in the web
  app use it. For a **conveyor** the belt coordinates also count from the shifted X; use this when the machine's
  queue coordinates do not start at the belt start. For robots it only moves the shown origin.

Tip: the measuring mode in the web app (key M) shows MCS and local coordinates of characteristic points. Use it to
check poses on the real machine.

## 5. Conveyors and products

FB: `SynVisu._FB_VisuConveyor`. A conveyor is a belt of a given length and width, plus a register of the products
on it (up to `VISU_un_MAX_PRODUCTS`, 4800).

### 5.1 Configuration

| Call | Meaning |
| --- | --- |
| `m_Configure(vi_Pose, vi_lr_Length, vi_lr_Width)` | `vi_Pose` is the centre of the belt start on the belt surface; local +X is the conveying direction, local Z the belt normal |
| `m_SetProductType(vi_udn_Id, vi_lr_Length, vi_lr_Width, vi_lr_Height, vi_e_Shape := BOX, vi_lr_CornerRadius := 0)` | One per product type on this belt (up to 8) |

Product shapes (`SynVisu.E_VisuProductShape`):

| Shape | Use for | Size |
| --- | --- | --- |
| `BOX` | cartons, trays | length (along the belt) × width × height |
| `CYLINDER` | cans, round or oval products | length and width are the two diameters: equal for round, different for oval |
| `ROUNDED_BOX` | pouches, flow packs | a box with rounded vertical edges of `vi_lr_CornerRadius` |

### 5.2 Belt position

Report the belt position once per cycle, **before** latching products in that cycle:

- `m_SetBeltPosition(vi_lr_Position)` for a continuous position in mm. It must not jump back or wrap.
- `m_SetModuloBeltPosition(vi_lr_ModuloPosition, vi_lr_ModuloPeriod, vi_b_Reset)` for a modulo axis. The FB unwraps
  it; the axis must move less than half a period per cycle.

Products on the belt move with the belt position: the visualisation computes each product's position from its latch
pose and how far the belt has moved since the latch. You do not report product positions every cycle.

### 5.3 The product lifecycle

Every product has an id that is unique on its conveyor and greater than 0. Its state (`SynVisu.E_VisuProductState`)
drives how it is drawn.

| Moment | Call | Shown as |
| --- | --- | --- |
| Product detected on the belt | `m_LatchProduct(vi_udn_Id, vi_LatchPose, vi_udn_ProductType, vi_udn_ClientId := fb_Vision.m_Id())` | `DETECTED`, travelling with the belt |
| A robot takes the product over | `m_SetProductState(vi_udn_Id, ASSIGNED, vi_udn_ClientId := fb_Delta.m_Id())` | `ASSIGNED`, coloured as allocated |
| The robot gives it up again | `m_SetProductState(vi_udn_Id, DETECTED, vi_udn_ClientId := fb_Delta.m_Id())` | `DETECTED`; the history says "released by" the robot |
| The robot picks it | `m_SetProductState(vi_udn_Id, PICKED, vi_udn_ClientId := fb_Delta.m_Id(), vi_udn_MoverId := 0, vi_udn_FingerId := 1)` | Hangs from the robot's finger; a placeholder outline stays on the belt |
| The robot puts it down on another belt | `fb_Infeed.m_RemoveProduct(vi_udn_Id)` and `fb_Outfeed.m_LatchProduct(..., vi_e_State := PLACED, vi_udn_ClientId := fb_Delta.m_Id())` | `PLACED` on the outfeed |
| Put back onto the same belt | `m_SetProductState(vi_udn_Id, PLACED, vi_udn_ClientId := fb_Delta.m_Id())` | `PLACED` |
| Rejected (bad product), e.g. by a reject unit | `m_SetProductState(vi_udn_Id, REJECTED, vi_udn_ClientId := fb_RejectUnit.m_Id())` | `REJECTED`, passes the belt end on purpose |
| Housekeeping, every cycle | `m_RemoveProductsBeyond(vi_lr_BeltX := Length + 300)` | Drops products beyond the belt end; keeps `ASSIGNED` and `PICKED` |

Rules:

- **Latch pose:** `vi_LatchPose` (`ST_VisuPlanarPose`: X, Y, Z, Rz) is the bottom centre of the product on the belt
  surface, in the conveyor's coordinate system (from its origin shift), at the latch moment. A product detected
  where the belt's coordinate system starts has `fX = 0`, one in the middle of the belt `fY = 0`, `fZ` is 0 on the
  belt surface. A product put down on top of another has `fZ` = the height of the one below; it travels with the belt
  on its own, so when the one below is picked, move the one above down yourself (`m_MoveProduct`, `fZ := 0`). If the product was detected some cycles earlier, pass the belt position
  of that moment in `vi_lr_LatchBeltPosition` with `vi_b_UseLatchBeltPosition := TRUE`.
- **Missed products:** a product that passes the belt end while still `DETECTED` or `ASSIGNED` is flagged as missed
  in the web app (red, counted in the metrics, marked on the recording's timeline). `PLACED` and `REJECTED`
  products pass the end on purpose.
- **Placing:** a robot works in the MCS (finger poses), so convert where its finger puts the product down into the
  outfeed's coordinate system, and set `fRz` to the finger's MCS rotation about Z minus the outfeed's, so the product
  keeps its orientation. For a belt along MCS +X: `fX = x − (pose.fX + shift.fX)`, `fY = y − (pose.fY + shift.fY)`.
- **The client:** every call that latches or changes a product names the client that does it in `vi_udn_ClientId`:
  the vision system, sensor or station that latched it, the robot that is assigned to, picks, places or releases it,
  the station that rejects it. The product keeps it as `nLastClientId`, with the state before the change as
  `ePreviousState`. The inspector's product history then says who did what ("detected by Vision 1", "picked by
  Delta 1", "rejected by Reject unit"), and the metrics count per client.
- **Reading the register:** `m_ProductCount()`, `m_GetProduct(vi_un_Index, vo_Product =>, vo_Pose =>)` (with the
  product's current pose in the conveyor's coordinate system: the latch pose moved along X by the belt travel), `m_FindProduct(vi_udn_Id)`. Useful when the machine's own data does not hold the
  product's position, e.g. to match a pick to the nearest mover.
- **Pushing a product along the belt** (e.g. a spacing XTS loop under the belt): `m_MoveProduct(vi_udn_Id, vi_Pose)`
  puts it at a new pose (conveyor coordinate system) at the current belt position and keeps its state.

### 5.4 Example

```st
(* Configuration *)
fb_Infeed.m_Configure(vi_Pose := InfeedPose, vi_lr_Length := 3000, vi_lr_Width := 400);
fb_Infeed.m_SetProductType(vi_udn_Id := 1, vi_lr_Length := 120, vi_lr_Width := 80, vi_lr_Height := 40);
fb_Infeed.m_SetProductType(vi_udn_Id := 2, vi_lr_Length := 80, vi_lr_Width := 80, vi_lr_Height := 40,
	vi_e_Shape := SynVisu.E_VisuProductShape.CYLINDER);

(* Each cycle: belt first, then latches *)
fb_Infeed.m_SetBeltPosition(axInfeed.NcToPlc.ActPos);
IF b_ProductLatched THEN
	(* In the infeed's coordinate system: along the belt from its origin, across from its middle, on its surface *)
	LatchPose.fX := lr_LatchX;
	LatchPose.fY := lr_LatchY;
	LatchPose.fZ := 0;
	LatchPose.fRz := lr_LatchRz;
	fb_Infeed.m_LatchProduct(vi_udn_Id := udn_ProductId, vi_LatchPose := LatchPose, vi_udn_ProductType := 1,
		vi_udn_ClientId := fb_Vision1.m_Id());
END_IF
fb_Infeed.m_RemoveProductsBeyond(3000 + 300);
```

## 6. Zones

A zone is a stretch of a conveyor that belongs to a component: where a robot picks or places, where a detector
detects, where a station works. All robots, detectors and stations have zones; the visualisation draws them alike.

```st
fb_Delta1.m_SetZone(vi_un_Zone := 1, vi_udn_ConveyorId := fb_Infeed.m_Id(),
	vi_lr_Start := 1100, vi_lr_End := 1900, vi_lr_AllocationOffset := 300, vi_lr_CcsOffset := 1100);
fb_Delta1.m_SetZone(vi_un_Zone := 2, vi_udn_ConveyorId := fb_Outfeed.m_Id(),
	vi_lr_Start := 1200, vi_lr_End := 1800, vi_lr_CcsOffset := 1200);
```

| Input | Meaning |
| --- | --- |
| `vi_un_Zone` | 1-based. Set the zones in order 1, 2, 3, ...; the count grows to the highest one set. Up to 8. |
| `vi_udn_ConveyorId` | The conveyor's id (`fb_Belt.m_Id()`) |
| `vi_lr_Start`, `vi_lr_End` | Belt coordinates in mm (from the belt start or its origin shift). `Start = End` draws a line across the belt, e.g. for a light barrier. |
| `vi_lr_AllocationOffset` | mm before `End` up to which the robot may still allocate products; drawn as its own area. 0 = no limit. |
| `vi_lr_CcsOffset` | Belt coordinate of the component's conveyor coordinate system (CCS), drawn as a dashed line. It should lie inside the zone. |

`m_ClearZones()` removes all zones, e.g. when a format change uses fewer zones.

## 7. Grippers and fingers

Every robot type (Delta, Cartesian, XTS gantry, XTS loop) may define a gripper made of **fingers**. A finger is
always drawn as a cylinder: a suction cup, a jaw, a pin. Picked products hang from a finger.

- **Define** the fingers once (every cycle is fine): `m_SetFinger(vi_un_Finger, vi_lr_Diameter, vi_lr_Height)`,
  1-based, up to 8. For XTS kinematics this defines the fingers of every mover's gripper.
- **Report** each finger every cycle, **absolute in the MCS**: the pose of the finger's frame and whether it grips.
  - Delta and Cartesian: `m_SetFingerState(vi_un_Finger, vi_Pose, vi_b_Active)`.
  - XTS gantry and loop: in the `vi_FingerStates` array of `m_SetMover` (index 0 = finger 1).
- **Finger frame:** origin at the centre of the finger's top face (where it is mounted). The finger extends along its
  local −Z; its grip point is the centre of its bottom face. A picked product's top touches the grip point and takes
  the finger's orientation.
- **Rotations:** a tool rotation (a Delta's 4th axis, an IDH's C, a Cartesian's C and A) is shown only through the
  finger poses. Turn the finger frame by that rotation.
- **Which finger carries a product:** `m_SetProductState(..., PICKED, vi_udn_ClientId, vi_udn_MoverId, vi_udn_FingerId)`.
  With `vi_udn_FingerId := 0` the product hangs at the gripper flange instead.
- **Without fingers:** the flange is drawn as a plate, green while `vi_b_GripperActive` (Cartesian, XTS gantry) is
  TRUE.

```st
(* A suction cup 50 mm high directly below a Delta's TCP, turned by the 4th axis *)
fb_Delta1.m_SetFinger(vi_un_Finger := 1, vi_lr_Diameter := 40, vi_lr_Height := 50);
CupPose.fX := Tcp.fX;
CupPose.fY := Tcp.fY;
CupPose.fZ := Tcp.fZ;
CupPose.fRz := lr_Axis4;
fb_Delta1.m_SetFingerState(vi_un_Finger := 1, vi_Pose := CupPose, vi_b_Active := b_Vacuum);
```

## 8. Delta robot

FB: `SynVisu._FB_VisuDelta`. The PLC reports only the TCP; the web app computes the arm posture from the geometry.

| Call | Meaning |
| --- | --- |
| `m_Configure(vi_Pose, vi_lr_BaseRadius, vi_lr_EffectorRadius, vi_lr_UpperArmLength, vi_lr_LowerArmLength)` | `vi_Pose` is the base centre in the MCS. Arm 1 lies along the base's local +X, arms 2 and 3 follow counter-clockwise (from above) at 120°. |
| `m_SetWorkingArea(vi_lr_Radius, vi_lr_ZMin, vi_lr_ZMax, vi_lr_ConeHeight, vi_lr_ConeBottomRadius)` | Vertical cylinder in the robot frame (Z negative below the base), optionally with a cone at the bottom |
| `m_SetLimitArea(...)`, `m_ClearLimitArea()` | Optional box in the robot frame that further restricts the working area, e.g. against a neighbouring robot |
| `m_SetFinger(...)` | See [section 7](#7-grippers-and-fingers) |
| `m_SetZone(...)` | See [section 6](#6-zones) |
| each cycle: `m_SetTcp(vi_ActualTcp, vi_SetpointTcp)` | TCP (effector centre, the gripper flange) as `ST_VisuPosition` in the MCS |
| each cycle: `m_SetFingerState(...)` | Per finger |

## 9. Cartesian robot

FB: `SynVisu._FB_VisuCartesian`. Two fixed rails along the local +Y, a bridge travelling in Y, a carriage on it
travelling in X and a vertical column (Z) ending at the gripper flange.

| Call | Meaning |
| --- | --- |
| `m_Configure(vi_Pose, vi_lr_XMin, vi_lr_XMax, vi_lr_YMin, vi_lr_YMax, vi_lr_ZMin, vi_lr_ZMax, vi_lr_RailHeight)` | `vi_Pose` is the axis origin (X = Y = 0); the strokes are the flange's; the rails' top lies at `vi_lr_RailHeight` above the origin |
| each cycle: `m_SetAxes(vi_lr_X, vi_lr_Y, vi_lr_Z, vi_b_GripperActive := FALSE)` | Actual axis values, i.e. the flange in the robot frame |
| each cycle: `m_SetFingerState(...)` | Per finger, absolute in the MCS |

If the machine's TCP is not the flange (a tool length), report the flange and let the finger reach down to the TCP:
the finger height is the tool length.

## 10. XTS tracks and their motor modules

Both XTS components, the gantry (e.g. IDH) and the loop (e.g. Fxx), describe their track the same way: as a chain of
**track modules** in the order the movers run along it. This mirrors the real hardware: a Beckhoff XTS track is
built from motor modules that are 250 mm long, straight or a 90° curve.

### 10.1 Module kinds

`SynVisu.E_VisuModuleKind`:

| Kind | Hardware | Drawn as |
| --- | --- | --- |
| `STRAIGHT` | straight motor module | a straight block |
| `CURVE_LEFT` | curve module, turning 90° to the left of the direction the track runs in | a quarter ring |
| `CURVE_RIGHT` | curve module, turning 90° to the right | a quarter ring |

Each module has a length along the track (track positions). The default is
`SynVisu.VISU_GlobalConst.VISU_lr_XTS_MODULE_LENGTH` = 250 mm. A curve module is drawn as a quarter circle as long as
the module (radius 2 · 250 / π ≈ 159.2 mm), so a mover's position on it is exact along the track. Two curve modules
in a row make the half turn at the end of a loop.

### 10.2 Setting the modules

```st
(* A straight track of six modules *)
FOR un_Module := 1 TO 6 DO
	fb_Idh.m_SetModule(vi_un_Module := un_Module, vi_e_Kind := SynVisu.E_VisuModuleKind.STRAIGHT);
END_FOR
```

- Modules are 1-based and must be set **in track order**, without gaps. Module 1 starts at the component's pose;
  each module starts where the one before it ends.
- **Track positions** count from the start of module 1. Report mover positions in this system.
- The count grows to the highest module set (up to `VISU_un_MAX_MODULES`, 64). If a format change shortens the
  track, call `m_ClearModules()` first.
- `m_TrackLength()` returns the sum of the module lengths: the range of track positions, on a loop its perimeter.
- Calling `m_SetModule` every cycle is fine; the config only changes when a module does.

### 10.3 Module faults

Each module can report its own fault, e.g. an overtemperature or a drive error of that motor module. The faulted
module is drawn red, its message hangs above it, it is listed with the component ("Module 11: Overtemperature") and
marked on the recording's timeline.

```st
fb_Fxx.m_SetModuleFault(vi_un_Module := 11, vi_b_Fault := b_Module11Overtemp,
	vi_str_FaultMessage := 'Overtemperature');
```

Unlike `m_SetFault` (section 14), module faults are live: call `m_SetModuleFault` every cycle with the module's
current state, for every module whose fault you know. A module you never report stays without fault.

## 11. XTS gantry

FB: `SynVisu._FB_VisuXtsGantry`. A straight XTS track carried by a common Z axis; every mover carries its own X axis
with a gripper flange at its end (e.g. IDH).

**Local frame:** origin at the track start on top of the movers with Z = 0; the track runs along local +Y, each
mover's X axis along local +X, the Z axis along local +Z. Turn the pose (`fRz`) so that the track lies where it does
in the machine.

| Call | Meaning |
| --- | --- |
| `m_Configure(vi_Pose, vi_lr_XMin, vi_lr_XMax, vi_lr_ZMin, vi_lr_ZMax, vi_lr_ToolOffsetX, vi_lr_ToolOffsetZ, vi_lr_MoverLength, vi_lr_MoverWidth)` | Strokes of the X axes and the Z axis; the gripper flange relative to the mover at X = 0 (ahead along +X, below the mover top negative); mover size |
| `m_SetModule(...)` | The track, [section 10](#10-xts-tracks-and-their-motor-modules) |
| `m_SetFinger(...)`, `m_SetZone(...)` | As for all robots |
| each cycle: `m_SetZPosition(vi_lr_Z)` | Common Z axis |
| each cycle: `m_SetMoverCount(vi_un_Count)` | How many mover entries follow; entries beyond are invalidated |
| each cycle, per mover: `m_SetMover(vi_un_Index, vi_udn_Id, vi_lr_Position, vi_lr_X, vi_b_GripperActive, vi_FingerStates, vi_b_Fault, vi_str_FaultMessage)` | `vi_un_Index` 0-based entry, `vi_udn_Id` the mover id (> 0, used by products' `nMoverId`), track position, X axis, finger states in the MCS, mover fault |

```st
fb_Idh.m_Configure(vi_Pose := IdhPose, vi_lr_XMin := 0, vi_lr_XMax := 700, vi_lr_ZMin := -100, vi_lr_ZMax := 0,
	vi_lr_ToolOffsetX := 150, vi_lr_ToolOffsetZ := -350, vi_lr_MoverLength := 155, vi_lr_MoverWidth := 80);
FOR un_Module := 1 TO 6 DO
	fb_Idh.m_SetModule(vi_un_Module := un_Module, vi_e_Kind := SynVisu.E_VisuModuleKind.STRAIGHT);
END_FOR
fb_Idh.m_SetFinger(vi_un_Finger := 1, vi_lr_Diameter := 40, vi_lr_Height := 50);

fb_Idh.m_SetZPosition(axZ.NcToPlc.ActPos);
fb_Idh.m_SetMoverCount(4);
FOR n_Mover := 0 TO 3 DO
	(* MoverFingers[0]: the cup's frame in the MCS, turned by the mover's C axis *)
	fb_Idh.m_SetMover(vi_un_Index := INT_TO_UINT(n_Mover), vi_udn_Id := INT_TO_UDINT(n_Mover + 1),
		vi_lr_Position := axMover[n_Mover].NcToPlc.ActPos, vi_lr_X := axX[n_Mover].NcToPlc.ActPos,
		vi_b_GripperActive := b_Vacuum[n_Mover], vi_FingerStates := MoverFingers[n_Mover],
		vi_b_Fault := b_MoverError[n_Mover], vi_str_FaultMessage := 'Following error');
END_FOR
```

## 12. XTS loop

FB: `SynVisu._FB_VisuXtsLoop`. A closed XTS track on which movers circulate, take products over, change their spacing
and hand them on (e.g. Fxx).

**Local frame:** origin at the start of module 1, which runs along local +X in the conveying direction. The loop
stands in the local X-Z plane: a `CURVE_LEFT` turns up towards +Z. A mover's gripper flange (tool point) lies
`vi_lr_ToolOffset` outwards from the track, to the right of its travel; on the lower straight that is below it.

The usual loop is a straight of n modules, two `CURVE_LEFT` up, n straight modules back and two `CURVE_LEFT` down to
the start:

```st
(* Fxx: 2 x 10 straight modules (2500 mm each way) and four curve modules; perimeter 6000 mm *)
fb_Fxx.m_Configure(vi_Pose := LoopPose, vi_lr_ToolOffset := 70, vi_lr_MoverLength := 100, vi_lr_MoverWidth := 60);
FOR un_Module := 1 TO 2 * (10 + 2) DO
	IF (un_Module - 1) MOD (10 + 2) < 10 THEN
		e_ModuleKind := SynVisu.E_VisuModuleKind.STRAIGHT;
	ELSE
		e_ModuleKind := SynVisu.E_VisuModuleKind.CURVE_LEFT;
	END_IF
	fb_Fxx.m_SetModule(vi_un_Module := un_Module, vi_e_Kind := e_ModuleKind);
END_FOR
fb_Fxx.m_SetFinger(vi_un_Finger := 1, vi_lr_Diameter := 40, vi_lr_Height := 50);

fb_Fxx.m_SetMoverCount(12);
FOR n_Mover := 0 TO 11 DO
	fb_Fxx.m_SetMover(vi_un_Index := INT_TO_UINT(n_Mover), vi_udn_Id := INT_TO_UDINT(n_Mover + 1),
		vi_lr_Position := axMover[n_Mover].NcToPlc.ActPos, vi_FingerStates := MoverFingers[n_Mover]);
END_FOR
```

- The two half turns at a loop's ends each consist of two curve modules: 500 mm of track and 2 · 159.2 mm of height,
  so the upper straight lies about 318 mm above the lower one.
- The chain must close: the end of the last module should meet the start of module 1. If it misses by more than
  1 mm, the web app shows a configuration warning ("the track modules do not close the loop").
- Mover positions run from 0 to `m_TrackLength()` in the conveying direction. If your XTS reports positions from a
  different start, add the offset so that 0 is the start of module 1.
- A loop under a belt (e.g. a spacing loop) is the same loop turned by `fRz := 180` and placed below the belt; see
  `P_VisuDemoSpacing` in the demo.

## 13. Vision system, product sensor and station

Detectors detect products in their zones, stations work on them. The application latches or changes the products on
the conveyor itself (with `vi_udn_ClientId` := the detector's or station's id); the FB only shows where the part is,
its zone and which of its bodies is active. They are drawn from simple bodies, so no web code is needed for them.

### 13.1 Vision system

FB: `SynVisu._FB_VisuVision`.

```st
(* The lens 800 mm above the belt surface, looking down; it sees 400 x 300 mm on the belt *)
LensPose.fX := 1000;
LensPose.fY := 0;
LensPose.fZ := InfeedPose.fZ + 800;
fb_Vision1.m_Configure(vi_Pose := LensPose, vi_lr_FieldLength := 400, vi_lr_FieldWidth := 300,
	vi_lr_WorkingDistance := 800);
fb_Vision1.m_SetZone(vi_un_Zone := 1, vi_udn_ConveyorId := fb_Infeed.m_Id(), vi_lr_Start := 800, vi_lr_End := 1200,
	vi_lr_CcsOffset := 1000);
```

`vi_Pose` is the lens, looking along its local −Z. `m_Configure` draws a housing, the lens and the field of view as a
frustum down to the working distance.

### 13.2 Product sensor (e.g. light barrier)

FB: `SynVisu._FB_VisuSensor`.

```st
(* Head at the belt side, the beam across the belt (local +Y) *)
fb_Barrier1.m_Configure(vi_Pose := HeadPose, vi_lr_BeamLength := 500);
fb_Barrier1.m_SetZone(vi_un_Zone := 1, vi_udn_ConveyorId := fb_Infeed.m_Id(), vi_lr_Start := 300, vi_lr_End := 300);
fb_Barrier1.m_SetSignal(b_BeamInterrupted);	// every cycle: the beam lights up while TRUE
```

### 13.3 Extra bodies

`m_SetBody(vi_un_Body, vi_e_Shape, vi_e_Role, vi_Pose, vi_lr_Length, vi_lr_Width, vi_lr_Height, ...)` adds solids,
e.g. a bracket. The vision system uses bodies 1–3 and the sensor bodies 1–2, so start at 4 or 3. The pose is the
body's bottom centre in the detector's frame; the body extends along its local +Z. Shapes: `BOX`, `CYLINDER`
(length and width are its diameters), `FRUSTUM` (with a top size). Roles: `STRUCTURE` and `SENSOR` are machine parts
that turn the active colour with `m_SetBodyActive(vi_un_Body, TRUE)`; `BEAM` and `FIELD_OF_VIEW` are overlays that
light up with it.

### 13.4 Station (e.g. reject unit, labeller, printer, check weigher)

FB: `SynVisu._FB_VisuStation`. Anything at a conveyor that works on products and has no kinematics of its own. It has
no default bodies: describe all of them. Example: a reject unit at the right belt edge whose pusher shoves every bad
product off the belt.

```st
(* Origin on the floor at the belt side, local +Y across the belt *)
StationPose.fX := 4500;
StationPose.fY := OutfeedPose.fY - 230;
StationPose.fZ := 0;
fb_RejectUnit.m_Configure(vi_Pose := StationPose);
BodyPose.fY := -70;	// housing beside the belt, up to 120 mm above the belt surface
fb_RejectUnit.m_SetBody(vi_un_Body := 1, vi_e_Shape := SynVisu.E_VisuBodyShape.BOX,
	vi_e_Role := SynVisu.E_VisuBodyRole.STRUCTURE, vi_Pose := BodyPose, vi_lr_Length := 160, vi_lr_Width := 140,
	vi_lr_Height := OutfeedPose.fZ + 120);
BodyPose.fY := 15;	// pusher plate at the belt edge, just above the belt
BodyPose.fZ := OutfeedPose.fZ + 10;
fb_RejectUnit.m_SetBody(vi_un_Body := 2, vi_e_Shape := SynVisu.E_VisuBodyShape.BOX,
	vi_e_Role := SynVisu.E_VisuBodyRole.STRUCTURE, vi_Pose := BodyPose, vi_lr_Length := 120, vi_lr_Width := 30,
	vi_lr_Height := 50);
fb_RejectUnit.m_SetZone(vi_un_Zone := 1, vi_udn_ConveyorId := fb_Outfeed.m_Id(), vi_lr_Start := 3000, vi_lr_End := 3000);

(* Every cycle: the pusher lights up while it pushes *)
fb_RejectUnit.m_SetBodyActive(vi_un_Body := 2, vi_b_Active := b_PusherOut);
(* When it rejects a product, and once the product is off the belt *)
fb_Outfeed.m_SetProductState(vi_udn_Id := udn_Bad, vi_e_State := SynVisu.E_VisuProductState.REJECTED,
	vi_udn_ClientId := fb_RejectUnit.m_Id());
fb_Outfeed.m_RemoveProduct(udn_Bad);
```

A station that measures or marks products without taking them off (a check weigher, a printer) can latch them like a
detector or leave them as they are; only state changes are shown. See `P_VisuDemoDelta.m_RejectUnit` in the demo.

## 14. Faults

There are three levels of faults, all shown red with their message:

| Level | Call | Lifetime |
| --- | --- | --- |
| Whole component (any FB) | `m_SetFault(vi_b_Active, vi_str_Message)` | **Latched:** stays until you call `m_SetFault(FALSE, '')` |
| One XTS mover | `vi_b_Fault`, `vi_str_FaultMessage` of `m_SetMover` | Live: as reported in each cycle |
| One XTS track module | `m_SetModuleFault(vi_un_Module, vi_b_Fault, vi_str_FaultMessage)` | Live: as reported in each cycle |

- Messages are `STRING(80)`, shown to the operator as they are; an empty message shows "Fault".
- There is one fault per component, mover or module at a time and no severity. Map the most relevant active error of
  the unit to it, e.g. from the machine's error handling.
- In the web app faults appear as red parts with a label, in the component list, in the inspector and as marks on
  the recording's timeline. The operator can jump from fault to fault in a recording.

```st
(* Simplest mapping: the unit's error flag and text, every cycle *)
fb_Delta1.m_SetFault(vi_b_Active := Delta1_Iface.b_Error, vi_str_Message := Delta1_Iface.str_ErrorText);
```

## 15. Wrapping existing machine code

On real machines the values come from the machine's own data structures (queues, kinematics configurations, axis
references). The proven way is a small layer of wrapper FBs in the application, e.g. a folder `SYNVIS`:

- **One main FB** (e.g. `_FB_SYNVIS_Main`) that owns all wrapper instances and is called once per cycle in the fast
  task, with its own symbol path as input:
  `fb_SYNVIS_Main(vi_str_Path := 'TCATx_Program_Fast.fb_SYNVIS_Main');`
- **One wrapper FB per kind of unit** (a queue, a PPH, an IDH, ...). It holds the `SynVisu` FB instance, converts the
  machine's data in a method `m_Cyclic(...)` and appends to the path it gets:
  `fb_Conveyor.m_Register(..., vi_str_Path := CONCAT(vi_str_Path, '.fb_Conveyor.vo_Visu'));`
- **Constants** (ids, product sizes, finger sizes) in one GVL, e.g. `SYNVIS_GlobalConst`.
- **Pick and place across units:** a product is picked by one unit (its queue) and placed by another (an outfeed
  queue or the robot's gripper releasing it). A shared helper FB that remembers which robot carries which product
  links the two: on pick it sets the product `PICKED`, on place it removes it and latches it `PLACED` on the target.

The RPL6 project (`RPP/31_Functions/SYNVIS`) follows this pattern and is a good starting point for a new machine.

## 16. Limits

The array sizes are library parameters (`SynVisu.VISU_GlobalConst_Param`):

| Constant | Value | Per |
| --- | --- | --- |
| `VISU_un_MAX_MANIFEST_ENTRIES` | 32 | PLC (components) |
| `VISU_un_MAX_PRODUCTS` | 4800 | conveyor |
| `VISU_un_MAX_PRODUCT_TYPES` | 8 | conveyor |
| `VISU_un_MAX_ZONES` | 8 | robot, detector or station |
| `VISU_un_MAX_MOVERS` | 40 | XTS gantry or loop |
| `VISU_un_MAX_FINGERS` | 8 | gripper |
| `VISU_un_MAX_BODIES` | 16 | detector or station |
| `VISU_un_MAX_MODULES` | 64 | XTS track |

Methods that would exceed a limit return FALSE and change nothing. A machine with more than 32 components can split
them over several PLCs (ADS ports); the gateway reads several sources and shows them side by side.

## 17. Checklist before commissioning

- [ ] `SynVisu` referenced; library version matches the gateway's protocol version (section 2.2).
- [ ] `GVL_Visu.stManifest` declared (or the gateway's `manifestPath` set).
- [ ] Every component registered every cycle with a unique id > 0 and the exact symbol path of its `vo_Visu`.
- [ ] Poses checked in the measuring mode: conveyors start where they start, robots stand where they stand.
- [ ] Every conveyor: product types set, belt position reported every cycle before latching,
      `m_RemoveProductsBeyond` called every cycle.
- [ ] Products: unique ids per conveyor, states follow the lifecycle (section 5.3), placed products latched as
      `PLACED` on the target and removed from the source.
- [ ] Zones set in order, conveyor ids from `m_Id()`, CCS inside the zone.
- [ ] Robots: fingers defined and reported every cycle in the MCS; picked products name the finger.
- [ ] XTS: modules set in track order, loop closes, mover positions count from the start of module 1, mover ids > 0.
- [ ] Faults mapped: component faults cleared again, mover and module faults reported every cycle.
- [ ] The web app's status bar shows no discovery errors and the component tree shows every component.

## 18. Troubleshooting

The gateway's discovery errors are shown in the web app's status bar ("n discovery errors", click for details) and
in the gateway log. Configuration warnings appear in the web app.

| Symptom / message | Cause | Fix |
| --- | --- | --- |
| "PLC reports protocol version X, but this gateway expects Y" | Library and gateway versions differ | Update the library or the gateway (section 2.2) |
| "Symbol has expected type ST_Visu... but is missing" | `vi_str_Path` does not point at the instance's `vo_Visu` | Correct the path (section 3.2); watch for renamed programs or instances |
| "Cannot read ...stConfig" | Symbol exists but cannot be read, e.g. hidden by an attribute or the PLC is stopped | Check the symbol in the ADS symbol table; start the PLC |
| Component missing in the tree, no error | `m_Register` not called, id 0, id used twice, or manifest full | Call it every cycle with a unique id; check its return value |
| "zone references unknown conveyor N" | Zone's conveyor id is not a registered conveyor | Use `fb_Belt.m_Id()`; register the conveyor |
| "CCS of the zone ... lies outside the zone" | `vi_lr_CcsOffset` not between start and end | Correct the CCS or the zone |
| "the track modules do not close the loop (N mm apart)" | Missing, extra or wrong-kind module in an XTS loop | Check the module list against the hardware |
| "product #n hangs from finger f, which robot #r does not have" | `vi_udn_FingerId` beyond the defined fingers | Define the finger or pass 0 |
| Products jump or run backwards | Belt position not continuous (modulo axis reported with `m_SetBeltPosition`) | Use `m_SetModuloBeltPosition` |
| Products appear in the wrong place | Latch pose not the bottom centre on the belt, or latch at a later belt position than the detection | Pass the correct pose; use `vi_lr_LatchBeltPosition` |
| Products flagged as missed at the belt end | They pass the end while `DETECTED` or `ASSIGNED` | Mark them `PICKED`, `PLACED` or `REJECTED` as they really are |
| Movers stand still or sit on the wrong module | Positions not in the track's system | Add the offset so that 0 is the start of module 1 |
| The view keeps re-reading the configuration (config version counting up all the time) | A configuration value changes every cycle, e.g. a pose computed with rounding noise or a value toggling | Configure from stable values; compute poses once |
| A component stays red | `m_SetFault` is latched | Clear it with `m_SetFault(FALSE, '')` |
