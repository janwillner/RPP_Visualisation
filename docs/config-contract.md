# Parameter set contract (library `Syn_Config`, config protocol version 2)

The library `Syn_Config` (ADR 0017) holds the parameter sets the configurator writes and the application takes over:
the part of a component's configuration the machine runs with, never its hardware. It is the PLC project
`plc/Syn_Config` in `plc/RPP_Visu.sln` (title `SynConfig`, namespace `SynConfig`, company `Syntegon Group`); it
references `Syn_Visu` for the shared types. The TypeScript mirror is `apps/gateway/src/config-contract.ts`, the
neutral model `packages/protocol/src/parameters.ts`. Change the three together, and bump
`CONFIG_GlobalConst.CONFIG_un_PROTOCOL_VERSION` / `CONFIG_PROTOCOL_VERSION` on any breaking change. Exported releases
are `plc/library/Syn_Config_<version>.library` and `.compiled-library`; the package ships the newest compiled one.
Its unit tests are the TcUnit suites `_FB_TestConfig*` in `plc/Syn_Visu_Test`, run against the installed library
(`docs/status.md`): install a new version before testing it.

## What the gateway reads and writes

| Symbol | Who | Content |
| --- | --- | --- |
| `GVL_Config.stManifest : SynConfig.ST_ConfigManifest` | declared by the application (as ADR 0003) | `nProtocolVersion`, `sLibraryVersion`, `nCount`, `aEntries[0..31]`: per parameter FB the `nId` of the Syn_Visu component it parametrises, its `eType` (`E_VisuComponentType`) and `sPath`, the symbol path of its `vo_Config` |
| `<sPath>.stStaging : ST_ConfigStaging` | written by the gateway | `nBaseVersion`, `nStageId`, `bReset`, `bStaged` |
| `<sPath>.stStaged : ST_Config<Type>Param` | written by the gateway | the proposed set |
| `<sPath>.stStatus : ST_ConfigStatus` | read every cycle | `nActiveVersion` (0 = program values), `nHandledStageId`, `eResult` (`E_ConfigResult`: NONE, PENDING, APPLIED, REJECTED), `sMessage` |
| `<sPath>.stActive : ST_Config<Type>Param` | read every cycle | the effective values |

A write goes in this order: `bStaged := FALSE` (withdraws a set still waiting), every leaf of the set,
`nBaseVersion`, `nStageId`, `bReset := FALSE`, and `bStaged := TRUE`. A reset writes `nBaseVersion`, `nStageId` and
`bReset := TRUE`. The ADS bridge sends all but the last value in one ADS sum-write and the last one (`bStaged` or
`bReset`) in a second request, only when none of the others failed: the PLC never takes over a set written half. The
parameter structures follow the naming convention of `docs/plc-contract.md`: the gateway derives every leaf path
from the protocol's schema (`plc-writing.ts`); array indices count from 0 (the ADS bridge maps them to the lower
bound; Syn_Config's arrays start at 0 anyway).

| Type | Parameter set (`ST_Config<Type>Param`) | Hardware, never written |
| --- | --- | --- |
| Conveyor (`_FB_ConfigConveyor`) | `stPose`, `stOriginShift`, `nProductTypeCount`, `aProductTypes` | length, width, body |
| Delta (`_FB_ConfigDelta`) | `stPose`, `stOriginShift`, `nZoneCount`, `aZones`, `nFingerCount`, `aFingers`, `stWorkingArea`, `stLimitArea`, `stTcpLimitArea` | radii, arm lengths |
| XTS gantry (`_FB_ConfigXtsGantry`) | `stPose`, `stOriginShift`, `nModuleCount`, `aModules`, `nZoneCount`, `aZones`, `nFingerCount`, `aFingers`, `stLimitArea`, `stTcpLimitArea` | strokes, tool offsets, mover size |
| XTS loop (`_FB_ConfigXtsLoop`) | `stPose`, `stOriginShift`, `nModuleCount`, `aModules`, `nZoneCount`, `aZones`, `nFingerCount`, `aFingers` | tool offset, mover size |
| Cartesian (`_FB_ConfigCartesian`) | `stPose`, `stOriginShift`, `nZoneCount`, `aZones`, `nFingerCount`, `aFingers`, `stLimitArea`, `stTcpLimitArea` | axes, strokes, rail height |
| Vision system, product sensor, station (`_FB_ConfigVision`, `_FB_ConfigSensor`, `_FB_ConfigStation`; one structure `ST_ConfigBodyComponentParam`, `vo_Config : ST_ConfigBodyComponent`) | `stPose`, `stOriginShift`, `nZoneCount`, `aZones` | bodies |

An XTS track's module chain and a gripper's fingers with their places on the flange (ADR 0018) are parameters, not
hardware: they are set up per machine (ADR 0016). The base `_FB_ConfigComponent` has the shared helpers every
parameter FB uses (`m_InvalidZones`, `m_InvalidModules`, `m_InvalidFingers`, `m_PassOnZones`, `m_PassOnModules`,
`m_PassOnFingers`, `m_PassOnLimitAreas`).

| Library | Config protocol | Change |
| --- | --- | --- |
| 2.0.0 | 2 | Gripper fingers (`nFingerCount`, `aFingers` with their `stOffset`) in the robots' sets; references Syn_Visu 9.5.0. The robots' structures changed: gateway and library are updated together |
| 1.1.0 | 1 | Parameter FBs for the XTS gantry and loop, the Cartesian robot, vision system, sensor and station |
| 1.0.0 | 1 | Conveyor and Delta |

## How a parameter FB handles a staging

Every cycle the application calls `m_Cycle(vio_Default, vio_Set, vi_b_ApplyAllowed)`:

1. `bReset`: the active set becomes invalid (`vio_Set.bValid := FALSE`), result APPLIED.
2. `bStaged` while `vi_b_ApplyAllowed` is FALSE: result PENDING, the set waits.
3. `bStaged` on another active version than `nBaseVersion`: REJECTED ("Based on version …").
4. `bStaged` with an invalid set (a count beyond its array; a product type without a number or twice; an XTS track
   without modules or a module without a length; a zone on no conveyor; a finger without a diameter or height):
   REJECTED with the reason.
5. Otherwise the set becomes active under the next version (`vio_Set.nLastVersion + 1`; versions never repeat).

In every handled case `nHandledStageId := nStageId` and the flags are cleared. Then `stActive` is the active set
while `vio_Set.bValid`, else `vio_Default`; `nActiveVersion` follows.

## Using it in a machine project

```st
VAR
	fb_InfeedParam				: SynConfig._FB_ConfigConveyor;
	InfeedDefault				: SynConfig.ST_ConfigConveyorParam;	// program values, filled every cycle
END_VAR
VAR PERSISTENT
	InfeedSet					: SynConfig.ST_ConfigConveyorSet;	// the active set, kept over a restart
END_VAR

fb_InfeedParam.m_Register(vio_Manifest := GVL_Config.stManifest, vi_udn_Id := fb_Infeed.m_Id());
fb_InfeedParam.m_Cycle(vio_Default := InfeedDefault, vio_Set := InfeedSet, vi_b_ApplyAllowed := b_MachineStopped);
fb_Infeed.m_Configure(vi_Pose := fb_InfeedParam.m_Pose(), vi_lr_Length := 3000, vi_lr_Width := 400);
fb_InfeedParam.m_PassOn(vio_Visu := fb_Infeed);	// origin shift and product types to Syn_Visu
```

- Declare `GVL_Config` with `stManifest : SynConfig.ST_ConfigManifest` and start the gateway with `--allow-write`.
- The machine logic reads the effective values (`m_Pose`, `m_Zone`, `m_ZoneCount`, `m_Active`), not its constants;
  the demo's Delta 1 allocates in the pick zone of its parameter set.
- `m_PassOn` passes the effective values on to Syn_Visu, so the visualisation shows what the machine uses; the
  configurator warns when they differ ("does the application pass them on?").
- **Upgrading to 2.0:** a robot's gripper fingers come with its parameter set. Put them into its program values
  (`nFingerCount`, `aFingers` with their `stOffset`) and remove the robot's own `m_SetFinger` calls: `m_PassOn` would
  clear the fingers the set does not have every cycle, and the visualisation's config version would change every
  cycle. The persistent sets of 1.x lose their layout: the PLC restores them only partly after the download.
- Syn_Visu cannot remove a product type: one a set no longer has stays in the visualisation until the application
  restarts.

The demo (`plc/Syn_Visu_Demo`) does this for Infeed 1, Delta 1 and Vision 1 (`P_VisuDemoDelta`; the vision system
latches its products under its effective lens position) and the IDH XTS gantry (`P_VisuDemoIdh`; its simulated motion
keeps to the program's track), taking a set over at once; the simulator emulates the same for one component of every
type (`apps/gateway/src/config-emulation.ts`).
