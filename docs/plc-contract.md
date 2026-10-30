# PLC contract (library `Syn_Visu`, protocol version 5)

This is the PLC side of the contract the gateway reads. It is implemented by the TwinCAT library project in
`plc/Syn_Visu` (solution `plc/ProductConfigurator.sln`). The TypeScript mirror is `apps/gateway/src/plc-contract.ts`,
and the gateway maps it to the neutral model in `packages/protocol`. Change all three together, and bump
`GVL_VisuConstants.nProtocolVersion` / `PROTOCOL_VERSION` on any breaking change.

## Conventions

- MCS: mm and degrees, right-handed, Z up, X in product flow direction.
- Pose rotation order: R = Rz(fRz) · Ry(fRy) · Rx(fRx).
- `nTimestamp`: distributed-clock time in ns since 2000-01-01 of the cycle that wrote the state. The component FBs set it.
- Cross-references (`nRobotId`, `nConveyorId`) use manifest `nId` values, never symbol paths; `nMoverId` uses the mover ids an XTS gantry or loop reports.
- `fBeltPosition` is a continuous position in mm (no modulo). For modulo axes use `FB_VisuConveyor.SetModuloBeltPosition`.
- Product latch pose = bottom centre of the product on the belt surface when it was latched.
- Delta: the PLC reports only the **TCP** (effector centre) in the MCS. The visualisation derives the arm posture by
  inverse kinematics from the configured geometry: arm 1 lies along the base's local +X, arms 2 and 3 follow
  counter-clockwise (seen from above) at 120°; 0° = upper arm horizontal, positive = downward. With
  `bHasRotationAxis` the effector is drawn rotated by the TCP's `fRz`.
- XTS gantry (e.g. IDH): local frame at the track start on top of the movers with Z = 0; the track runs along local +Y,
  each mover's X axis along local +X, the common Z axis along local +Z. Gripper TCP of a mover in the local frame:
  (X + `fToolOffsetX`, position, Z + `fToolOffsetZ`), turned about local +Z by C (C = 0 along local +X, positive
  counter-clockwise from above). Only actual values are reported.
- XTS loop (e.g. Fxx): local frame at the start of the lower straight, which runs along local +X; the loop stands in the
  local X-Z plane with the upper straight at +2R. Mover positions run from there in the conveying direction over the far
  curve and back along the upper straight (0..2L + 2πR). The curves are drawn as semicircles. A mover's tool point lies
  `fToolOffset` outwards from the track.
- Cartesian robot: two fixed rails along local +Y with their top at `fRailHeight`, a bridge travelling in Y on them, a
  carriage on the bridge travelling in X, a vertical column (Z) and a gripper head. Local frame: origin at axis
  X = Y = 0, Z up; the flange is at (X, Y, Z). TCP = flange + Rz(C) · Rx(A) · (0, 0, −`fToolLength`): C turns about
  local +Z (C = 0 along local +X, positive counter-clockwise from above), A tilts about the gripper's own, C-turned X
  axis (A = 0 points straight down). Only actual values are reported. The parts are drawn with fixed sizes derived
  from the strokes; the working-area box is the TCP volume with A = 0.
- A product in state PICKED with `nRobotId` = an XTS gantry or loop and `nMoverId` = one of its movers is drawn at that
  mover's gripper / tool point; with `nMoverId` = 0 it hangs at a Delta's or Cartesian robot's TCP, turned (and for a
  Cartesian robot tilted) with it. When placing, set the product's latch `fRz` to the gripper's MCS orientation (for a
  Cartesian robot: pose `fRz` + C) so it stays turned on the belt.
- Protocol version 2 removed the Delta axis positions (`aAxisPositions`) and axis calibration (`aAxes`) of version 1.
- Protocol version 3 renamed `stWorkArea` to `stWorkingArea` and the windows (`nWindowCount`, `aWindows`, `ST_VisuWindow`, `E_VisuWindowKind`) to zones (`nZoneCount`, `aZones`, `ST_VisuZone`, `E_VisuZoneKind`).
- Protocol version 4 added the XTS gantry and XTS loop and the product's `nMoverId`, and renamed `fEncoder` to `fBeltPosition` and `fLatchEncoder` to `fLatchBeltPosition`.
- Protocol version 5 added the Cartesian robot.

## What the library contains

Applications use the component function blocks. The structures underneath are the contract the gateway reads;
the FBs fill them, so application code does not write them directly.

| Object | Purpose |
| --- | --- |
| `FB_VisuConveyor` | One conveyor with its product register (methods below) |
| `FB_VisuDelta` | One Delta robot (methods below) |
| `FB_VisuXtsGantry` | One XTS gantry, e.g. IDH (methods below) |
| `FB_VisuXtsLoop` | One XTS loop, e.g. Fxx (methods below) |
| `FB_VisuCartesian` | One Cartesian robot (methods below) |
| `FB_VisuComponent` | Abstract base of all: `Register`, `Id`, config version and DC timestamps |
| `ST_VisuManifest`, `ST_VisuManifestEntry`, `E_VisuComponentType` | Discovery: which components exist and where |
| `ST_VisuConveyor` (`stConfig` / `stState`), `ST_VisuProduct`, `ST_VisuProductType`, `E_VisuProductState` | Conveyor contract structure (`FB_VisuConveyor.stVisu`) |
| `ST_VisuDelta` (`stConfig`: geometry, working area, zones / `stState`: actual and setpoint TCP), `ST_VisuWorkingArea`, `ST_VisuZone`, `E_VisuZoneKind` | Delta contract structure (`FB_VisuDelta.stVisu`) |
| `ST_VisuXtsGantry` (`stConfig`: track, strokes, gripper offsets, mover size, zones / `stState`: Z and movers), `ST_VisuGantryMover` | XTS gantry contract structure (`FB_VisuXtsGantry.stVisu`) |
| `ST_VisuXtsLoop` (`stConfig`: straight length, curve radius, tool offset, mover size, zones / `stState`: movers), `ST_VisuLoopMover` | XTS loop contract structure (`FB_VisuXtsLoop.stVisu`) |
| `ST_VisuCartesian` (`stConfig`: X/Y/Z/C/A strokes, tool length, rail height, zones / `stState`: X, Y, Z, C, A, gripper) | Cartesian robot contract structure (`FB_VisuCartesian.stVisu`) |
| `ST_VisuPose`, `ST_VisuPlanarPose` | MCS poses |
| `GVL_VisuConstants` | `nProtocolVersion` (contract version; `ST_VisuManifest` initialises to it), `fDegToRad` |
| `GVL_VisuParam` | Array sizes: `nMaxManifestEntries` (32), `nMaxProducts` (128), `nMaxProductTypes` (8), `nMaxZones` (8), `nMaxMovers` (40) |
| `F_GetVersionSyn_Visu` | Library version at runtime (2.0.0) |

### Methods

All component FBs:

| Method | Purpose |
| --- | --- |
| `Register(stManifest, nId, sName, sPath)` | Adds the component to the manifest (bumps `nConfigVersion` when new). `sPath` is the symbol path of the instance's `stVisu`. Idempotent: call it every cycle, which also keeps `nProtocolVersion` current and the manifest reference valid after an online change |
| `Id()` | Manifest id given to `Register`, 0 before |

All configuration methods may be called every cycle: they bump `nConfigVersion` only when a value actually changes,
and return TRUE in that case.

`FB_VisuConveyor`:

| Method | Purpose |
| --- | --- |
| `Configure(stPose, fLength, fWidth)` | Pose of the belt start and size |
| `SetProductType(nId, fLength, fWidth, fHeight)` | Adds or updates a product type |
| `SetBeltPosition(fPosition)` | Belt position (continuous, mm) and state timestamp; call once per cycle |
| `SetModuloBeltPosition(fModuloPosition, fModuloPeriod, bReset)` | Same for a modulo axis; unwraps to a continuous position |
| `LatchProduct(nId, stLatchPose, nProductType)` | Adds a detected product at the current belt position (or at `fLatchBeltPosition` with `bUseLatchBeltPosition`) |
| `SetProductState(nId, eState, nRobotId, nMoverId := 0)` | Changes state, assigned robot and carrying mover |
| `RemoveProduct(nId)` | Removes one product |
| `RemoveProductsBeyond(fBeltX)` | Drops invalid entries and products beyond `fBeltX` mm along the belt; keeps ASSIGNED and PICKED ones |
| `ProductCount()`, `GetProduct(nIndex, stProduct =>, stPose =>)`, `FindProduct(nId)` | Read the register; `stPose` is the product's current MCS pose |
| `BeltPosition()` | Belt position last set |

`FB_VisuDelta`:

| Method | Purpose |
| --- | --- |
| `Configure(stPose, fBaseRadius, fEffectorRadius, fUpperArmLength, fLowerArmLength, bHasRotationAxis)` | Base pose and geometry |
| `SetWorkingArea(fRadius, fZMin, fZMax, fConeHeight, fConeBottomRadius)` | Working area |
| `SetZone(nConveyorId, eKind, fStart, fEnd)` | Adds or updates the pick or place zone for a conveyor |
| `ClearZones()` | Removes all zones |
| `SetTcp(stActualTcp, stSetpointTcp)` | Reports the TCP and the state timestamp; call once per cycle |
| `BasePose()` | Base pose last configured |

`FB_VisuXtsGantry`:

| Method | Purpose |
| --- | --- |
| `Configure(stPose, nModuleCount, fModuleLength, fXMin, fXMax, fZMin, fZMax, fCMin, fCMax, fToolOffsetX, fToolOffsetZ, fMoverLength, fMoverWidth)` | Pose, track, strokes, gripper offsets, mover size |
| `SetZone(...)`, `ClearZones()` | As for the Delta |
| `SetZPosition(fZ)` | Common Z axis and state timestamp; call once per cycle |
| `SetMoverCount(nCount)` | Number of mover entries evaluated; entries beyond are invalidated |
| `SetMover(nIndex, nId, fPosition, fX, fC, bGripperActive)` | One mover's actual values |

`FB_VisuXtsLoop`:

| Method | Purpose |
| --- | --- |
| `Configure(stPose, fStraightLength, fCurveRadius, fToolOffset, fMoverLength, fMoverWidth)` | Pose, track geometry, tool offset, mover size |
| `SetZone(...)`, `ClearZones()` | As for the Delta |
| `SetMoverCount(nCount)` | Number of mover entries evaluated; entries beyond are invalidated |
| `SetMover(nIndex, nId, fPosition)` | One mover's position along the loop |
| `Perimeter()` | Loop length as the visualisation computes it, mm |

`FB_VisuCartesian`:

| Method | Purpose |
| --- | --- |
| `Configure(stPose, fXMin, fXMax, fYMin, fYMax, fZMin, fZMax, fCMin, fCMax, fAMin, fAMax, fToolLength, fRailHeight)` | Pose, strokes, tool length, rail height |
| `SetZone(...)`, `ClearZones()` | As for the Delta |
| `SetAxes(fX, fY, fZ, fC := 0, fA := 0, bGripperActive := FALSE)` | Actual axis values, gripper and state timestamp; call once per cycle |

## Using it in an application

The manifest is **declared by the application**, not the library (ADR-0003). That keeps the ADS symbol path the gateway
reads independent of the library's namespace. The gateway expects `GVL_Visu.stManifest`; an application that declares
the manifest elsewhere sets the gateway option `manifestPath` to that symbol path. Component instances can live anywhere; the
symbol path of their `stVisu` goes into the manifest.

```st
{attribute 'qualified_only'}
VAR_GLOBAL
    // GVL_Visu (application project)
    stManifest : Syn_Visu.ST_VisuManifest;
END_VAR
```

```st
PROGRAM MAIN
VAR
    fbInfeed : Syn_Visu.FB_VisuConveyor;
    fbDelta1 : Syn_Visu.FB_VisuDelta;
END_VAR

fbInfeed.Register(stManifest := GVL_Visu.stManifest, nId := 1, sName := 'Infeed', sPath := 'MAIN.fbInfeed.stVisu');
fbDelta1.Register(stManifest := GVL_Visu.stManifest, nId := 10, sName := 'Delta 1', sPath := 'MAIN.fbDelta1.stVisu');

fbInfeed.Configure(stPose := stInfeedPose, fLength := 5000, fWidth := 400);
fbInfeed.SetProductType(nId := 1, fLength := 120, fWidth := 80, fHeight := 40);
fbInfeed.SetModuloBeltPosition(fModuloPosition := <axis modulo position>, fModuloPeriod := <modulo period>, bReset := FALSE);
IF bLatched THEN
    fbInfeed.LatchProduct(nId := nNextId, stLatchPose := stLatchPose, nProductType := 1);
END_IF

fbDelta1.Configure(stPose := stDeltaBase, fBaseRadius := 200, fEffectorRadius := 50,
    fUpperArmLength := 400, fLowerArmLength := 1000, bHasRotationAxis := TRUE);
fbDelta1.SetZone(nConveyorId := fbInfeed.Id(), eKind := Syn_Visu.E_VisuZoneKind.PICK, fStart := 1100, fEnd := 1900);
fbDelta1.SetTcp(stActualTcp := stTcp, stSetpointTcp := stTcpSetpoint);
```

`P_VisuDemo` in the library project is a complete example, including an XTS loop, an XTS gantry and a Cartesian robot.

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
