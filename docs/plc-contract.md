# PLC contract (library `Tc3_Visu`, protocol version 1)

This is the PLC side of the contract the gateway reads. The TypeScript mirror is
`apps/gateway/src/plc-contract.ts`, and the gateway maps it to the neutral model in `packages/protocol`.
Change all three together, and bump `nProtocolVersion` / `PROTOCOL_VERSION` on any breaking change.

> The TwinCAT library project itself is not yet in the repo. These declarations are the
> specification it must implement. The library name `Tc3_Visu` comes from the spec. Note that Beckhoff
> reserves the `Tc` prefix for its own libraries, so a company prefix may be preferable when the
> project is created.

## Conventions

- MCS: mm and degrees, right-handed, Z up, X in product flow direction.
- Pose rotation order: R = Rz(fRz) · Ry(fRy) · Rx(fRx).
- `nTimestamp`: distributed-clock time in ns (ULINT) of the cycle that wrote the state.
- Cross-references (`nRobotId`, `nConveyorId`) use manifest `nId` values, never symbol paths.
- `fEncoder` is a continuous position in mm (no modulo). The library converts modulo axes.
- Product latch pose = bottom centre of the product on the belt surface when it was latched.
- Delta angle convention: 0° = upper arm horizontal, positive = arm pointing downward. Arm 1 lies
  along local +X; arms 2 and 3 follow counter-clockwise (seen from above) at 120°.
  Conventional angle = `nDirection` · raw + `fAngleOffset`.

## Discovery

The gateway reads `GVL_Visu.stManifest` and refuses to continue when `nProtocolVersion` differs from
its own. For each of the first `nCount` entries it checks that the symbol at `sPath` has the data type
`ST_VisuConveyor` or `ST_VisuDelta` (according to `eType`), then reads `<sPath>.stConfig` once. Every
cycle it sum-reads `GVL_Visu.stManifest.nConfigVersion` and all `<sPath>.stState`. Increment
`nConfigVersion` after changing any `stConfig` or the manifest.

## Declarations

```st
// Both blocks live in GVL_Visu.
{attribute 'qualified_only'}
VAR_GLOBAL CONSTANT
    nProtocolVersion    : UINT := 1;
    // Library parameters, overridable per project
    nMaxManifestEntries : UINT := 32;
    nMaxProducts        : UINT := 128;
    nMaxProductTypes    : UINT := 8;
    nMaxWindows         : UINT := 8;
END_VAR

{attribute 'qualified_only'}
VAR_GLOBAL

    stManifest : ST_VisuManifest;
END_VAR

{attribute 'qualified_only'}
TYPE E_VisuComponentType : (
    CONVEYOR := 1,
    DELTA    := 2
) UINT;
END_TYPE

{attribute 'qualified_only'}
TYPE E_VisuProductState : (
    DETECTED := 0,
    ASSIGNED := 1,
    PICKED   := 2,
    REJECTED := 3,
    PLACED   := 4
) UINT;
END_TYPE

{attribute 'qualified_only'}
TYPE E_VisuWindowKind : (
    PICK  := 1,
    PLACE := 2
) UINT;
END_TYPE

TYPE ST_VisuPose : STRUCT
    fX, fY, fZ    : LREAL;  // mm
    fRx, fRy, fRz : LREAL;  // degrees
END_STRUCT END_TYPE

TYPE ST_VisuPlanarPose : STRUCT
    fX, fY, fZ : LREAL;  // mm
    fRz        : LREAL;  // degrees
END_STRUCT END_TYPE

TYPE ST_VisuManifestEntry : STRUCT
    nId   : UDINT;                // unique, > 0
    eType : E_VisuComponentType;
    sName : STRING(80);           // display name
    sPath : STRING(255);          // symbol path of the ST_VisuConveyor / ST_VisuDelta instance
END_STRUCT END_TYPE

TYPE ST_VisuManifest : STRUCT
    nProtocolVersion : UINT;
    nConfigVersion   : UDINT;
    nCount           : UINT;
    aEntries         : ARRAY[0..nMaxManifestEntries - 1] OF ST_VisuManifestEntry;
END_STRUCT END_TYPE

// ----- Conveyor -----

TYPE ST_VisuProductType : STRUCT
    nId                       : UDINT;
    fLength, fWidth, fHeight  : LREAL;  // mm
END_STRUCT END_TYPE

TYPE ST_VisuConveyorConfig : STRUCT
    stPose            : ST_VisuPose;   // belt start, local +X = conveying direction
    fLength, fWidth   : LREAL;         // mm
    nProductTypeCount : UINT;
    aProductTypes     : ARRAY[0..nMaxProductTypes - 1] OF ST_VisuProductType;
END_STRUCT END_TYPE

TYPE ST_VisuProduct : STRUCT
    nId           : UDINT;
    bValid        : BOOL;
    stLatchPose   : ST_VisuPlanarPose;  // MCS, bottom centre at latch time
    fLatchEncoder : LREAL;              // conveyor fEncoder at latch time
    eState        : E_VisuProductState;
    nRobotId      : UDINT;              // manifest id of the assigned robot, 0 = none
    nProductType  : UDINT;
END_STRUCT END_TYPE

TYPE ST_VisuConveyorState : STRUCT
    nTimestamp    : ULINT;  // DC time, ns
    fEncoder      : LREAL;  // continuous belt surface position, mm
    nProductCount : UINT;   // entries [0..nProductCount-1] are evaluated; invalid ones are skipped
    aProducts     : ARRAY[0..nMaxProducts - 1] OF ST_VisuProduct;
END_STRUCT END_TYPE

TYPE ST_VisuConveyor : STRUCT
    stConfig : ST_VisuConveyorConfig;
    stState  : ST_VisuConveyorState;
END_STRUCT END_TYPE

// ----- Delta -----

TYPE ST_VisuDeltaAxisConfig : STRUCT
    fAngleOffset : LREAL;  // degrees
    nDirection   : INT;    // +1 or -1
END_STRUCT END_TYPE

TYPE ST_VisuWorkArea : STRUCT
    fRadius           : LREAL;  // vertical cylinder in the robot frame, mm
    fZMin, fZMax      : LREAL;  // relative to the base, mm (below the base: negative)
    fConeHeight       : LREAL;  // optional cone below fZMin; 0 = none
    fConeBottomRadius : LREAL;
END_STRUCT END_TYPE

TYPE ST_VisuWindow : STRUCT
    nConveyorId  : UDINT;           // manifest id of the conveyor
    fStart, fEnd : LREAL;           // mm along the conveyor's local X (belt coordinates)
    eKind        : E_VisuWindowKind;
END_STRUCT END_TYPE

TYPE ST_VisuDeltaConfig : STRUCT
    stPose                            : ST_VisuPose;  // base centre
    fBaseRadius, fEffectorRadius      : LREAL;        // mm
    fUpperArmLength, fLowerArmLength  : LREAL;        // mm
    bHasRotationAxis                  : BOOL;
    aAxes                             : ARRAY[0..3] OF ST_VisuDeltaAxisConfig;  // [3] only with bHasRotationAxis
    stWorkArea                        : ST_VisuWorkArea;
    nWindowCount                      : UINT;
    aWindows                          : ARRAY[0..nMaxWindows - 1] OF ST_VisuWindow;
END_STRUCT END_TYPE

TYPE ST_VisuDeltaState : STRUCT
    nTimestamp     : ULINT;              // DC time, ns
    aAxisPositions : ARRAY[0..3] OF LREAL;  // raw actual positions, degrees
    stActualTcp    : ST_VisuPlanarPose;  // MCS
    stSetpointTcp  : ST_VisuPlanarPose;  // MCS
END_STRUCT END_TYPE

TYPE ST_VisuDelta : STRUCT
    stConfig : ST_VisuDeltaConfig;
    stState  : ST_VisuDeltaState;
END_STRUCT END_TYPE
```
