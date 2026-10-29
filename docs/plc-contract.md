# PLC contract (library `Syn_Visu`, protocol version 1)

This is the PLC side of the contract the gateway reads. It is implemented by the TwinCAT library project in
`plc/Syn_Visu` (solution `plc/ProductConfigurator.sln`). The TypeScript mirror is `apps/gateway/src/plc-contract.ts`,
and the gateway maps it to the neutral model in `packages/protocol`. Change all three together, and bump
`GVL_VisuConstants.nProtocolVersion` / `PROTOCOL_VERSION` on any breaking change.

## Conventions

- MCS: mm and degrees, right-handed, Z up, X in product flow direction.
- Pose rotation order: R = Rz(fRz) · Ry(fRy) · Rx(fRx).
- `nTimestamp`: distributed-clock time in ns since 2000-01-01 (`F_VisuDcTime()`) of the cycle that wrote the state.
- Cross-references (`nRobotId`, `nConveyorId`) use manifest `nId` values, never symbol paths.
- `fEncoder` is a continuous position in mm (no modulo). Use `FB_VisuContinuousEncoder` for modulo axes.
- Product latch pose = bottom centre of the product on the belt surface when it was latched.
- Delta angle convention: 0° = upper arm horizontal, positive = arm pointing downward. Arm 1 lies along the base's
  local +X; arms 2 and 3 follow counter-clockwise (seen from above) at 120°.
  Conventional angle = `nDirection` · raw + `fAngleOffset`.

## What the library contains

| Object | Purpose |
| --- | --- |
| `ST_VisuManifest`, `ST_VisuManifestEntry`, `E_VisuComponentType` | Discovery: which components exist and where |
| `ST_VisuConveyor` (`stConfig` / `stState`), `ST_VisuProduct`, `ST_VisuProductType`, `E_VisuProductState` | Conveyor with product register |
| `ST_VisuDelta` (`stConfig` / `stState`), `ST_VisuDeltaAxisConfig`, `ST_VisuWorkArea`, `ST_VisuWindow`, `E_VisuWindowKind` | Delta robot, work area, pick/place windows |
| `ST_VisuPose`, `ST_VisuPlanarPose` | MCS poses |
| `GVL_VisuConstants.nProtocolVersion` | Contract version; `ST_VisuManifest` initialises to it |
| `GVL_VisuParam` | Array sizes: `nMaxManifestEntries` (32), `nMaxProducts` (128), `nMaxProductTypes` (8), `nMaxWindows` (8) |
| `F_VisuAddComponent` | Registers a component in the manifest and bumps `nConfigVersion`; idempotent, safe to call every cycle |
| `F_VisuDcTime` | DC time of the current task cycle, for `nTimestamp` |
| `FB_VisuContinuousEncoder` | Modulo axis position → continuous `fEncoder` |
| `F_GetVersionSyn_Visu` | Library version at runtime |

## Using it in an application

The manifest is **declared by the application**, not the library. That keeps the ADS symbol path the gateway reads
fixed at `GVL_Visu.stManifest`, whatever namespace the library gets. Component instances can live anywhere; their
symbol path goes into the manifest.

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
    stInfeed    : Syn_Visu.ST_VisuConveyor;
    stDelta1    : Syn_Visu.ST_VisuDelta;
    fbInfeedEnc : Syn_Visu.FB_VisuContinuousEncoder;
    nNow        : ULINT;
END_VAR

Syn_Visu.F_VisuAddComponent(stManifest := GVL_Visu.stManifest, nId := 1,
    eType := Syn_Visu.E_VisuComponentType.CONVEYOR, sName := 'Infeed', sPath := 'MAIN.stInfeed');
Syn_Visu.F_VisuAddComponent(stManifest := GVL_Visu.stManifest, nId := 10,
    eType := Syn_Visu.E_VisuComponentType.DELTA, sName := 'Delta 1', sPath := 'MAIN.stDelta1');

nNow := Syn_Visu.F_VisuDcTime();
fbInfeedEnc(fModuloPosition := <axis modulo position>, fModuloPeriod := <modulo period>);
stInfeed.stState.nTimestamp := nNow;
stInfeed.stState.fEncoder := fbInfeedEnc.fPosition;
// ... fill stConfig once, the product register and stDelta1.stState every cycle.
// After changing any stConfig at runtime: GVL_Visu.stManifest.nConfigVersion := GVL_Visu.stManifest.nConfigVersion + 1;
```

## Discovery

The gateway reads `GVL_Visu.stManifest` and refuses to continue when `nProtocolVersion` differs from its own. For each
of the first `nCount` entries it checks that the symbol at `sPath` has the data type `ST_VisuConveyor` or `ST_VisuDelta`
according to `eType`. Names qualified with the library namespace, such as `Syn_Visu.ST_VisuDelta`, are accepted too.
It then reads `<sPath>.stConfig` once. Every cycle it sum-reads `GVL_Visu.stManifest.nConfigVersion` and all
`<sPath>.stState`.

## Enumerations

| Enum | Values |
| --- | --- |
| `E_VisuComponentType` (UINT) | `NONE` 0, `CONVEYOR` 1, `DELTA` 2 |
| `E_VisuProductState` (UINT) | `DETECTED` 0, `ASSIGNED` 1, `PICKED` 2, `REJECTED` 3, `PLACED` 4 |
| `E_VisuWindowKind` (UINT) | `PICK` 1, `PLACE` 2 |

Values are part of the contract: append, never renumber.
