# Parameter set contract (library `Syn_Config`, config protocol version 4)

The library `Syn_Config` (ADR 0017) holds the parameter sets the configurator writes and the application takes over:
the part of a component's configuration the machine runs with, never its hardware. It is the PLC project
`plc/Syn_Config` in `plc/RPP_Visu.sln` (title `SynConfig`, namespace `SynConfig`, company `Syntegon Group`); it
references `Syn_Visu` for the shared types. The TypeScript side: the manifest, staging, status and machine FB
structures in `apps/gateway/src/config-contract.ts`; a parameter set's fields are its component type's `parameters`
in `COMPONENT_SCHEMAS` (`packages/protocol/src/model.ts`), mapped to the `ST_Config<Type>Param` members by the naming
convention, its PLC structure's name `plcConfigType` in the gateway's `COMPONENTS`; the messages in
`packages/protocol/src/parameters.ts`. Change them together, and bump
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

The machine FB (`_FB_ConfigMachine`, config protocol 3, ADR 0022) is listed with `nId` 0 and `eType` NONE; its
`vo_Config : ST_ConfigMachine` holds the machine's recipe and its commands:

| Member | Who | Content |
| --- | --- | --- |
| `nFieldCount`, `aFields[0..63] : ST_ConfigRecipeField` | read at discovery | the declared recipe fields: `sName`, `nGroup` (component id, 0 = machine), `eType` (`E_ConfigFieldType`: NUMBER, INTEGER, SWITCH, CHOICE), `sUnit`, `fMin`, `fMax`, `fProgramValue`, `nChoiceCount`, `aChoices[0..7]`; from config protocol 4 also `sLabel` (STRING(40), '' = the name put into words), `sDescription` (STRING(160)), `nVisibleField` (the field it applies only with, from 1; 0 = always) and `nVisibleValue` (DINT, the value that field must have) |
| `stStaging : ST_ConfigStaging`, `aStaged[0..63] : LREAL` | written by the gateway | as a parameter set's: the proposed recipe by field index |
| `stStatus : ST_ConfigStatus`, `aActive[0..63] : LREAL` | read every cycle | the recipe's status and effective values by field index |
| `stCommand : ST_ConfigCommand` | written by the gateway | `nCommandId`, `eCommand` (`E_ConfigCommand`: START, STOP, RESET), `bRequested` last |
| `stCommandStatus : ST_ConfigCommandStatus` | read every cycle | `nHandledCommandId`, `eResult` (`E_ConfigCommandResult`: NONE, ACCEPTED, REJECTED), `sMessage` |

Every recipe value travels as LREAL, whatever its type (a SWITCH 0 or 1, an INTEGER or CHOICE a whole number), so the
gateway needs no type per application. A recipe write goes like a parameter set's: `bStaged := FALSE`, every field's
`aStaged[i]` (a field the client left out keeps its effective value), `nBaseVersion`, `nStageId`, `bReset := FALSE`,
`bStaged := TRUE`; a command writes `nCommandId`, `eCommand` and `bRequested := TRUE`. The gateway checks every value
against its field (type, min, max, choices) before it writes, and writes recipes and commands only while the PLC
reports simulation mode in its machine entry (`GVL_Visu.stMachine.bSimulation`, protocol 22).

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
| 2.2.0 | 4 | A recipe field's label, description and visibility condition (`sLabel`, `sDescription`, `nVisibleField`, `nVisibleValue`; `m_SetText`, `m_SetVisibleWhen`; #49). `m_DeclareField` and the persistent `ST_ConfigRecipeSet` are unchanged; the gateway still reads config protocol 3, its fields without them |
| 2.1.0 | 3 | The machine FB `_FB_ConfigMachine`: recipe fields the application declares, their staging, machine commands (ADR 0022). No change to the parameter FBs; the gateway still writes parameter sets to a PLC of config protocol 2 |
| 2.0.1 | 2 | References `SynVisu` through a placeholder (default: the newest installed) instead of a fixed version, so an application uses one SynVisu for both libraries; redirect the placeholder in the application's library manager when it pins SynVisu. No change to the structures |
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

## The machine FB: recipe fields and machine commands

A recipe holds the process values the machine runs with (belt and robot speeds, picks per cycle, the product
pattern), as the application declares them; the Simulator writes them with the same staging as parameter sets
(ADR 0022). One `_FB_ConfigMachine` per application:

```st
VAR
	fb_Machine					: SynConfig._FB_ConfigMachine;
END_VAR
VAR PERSISTENT
	RecipeSet					: SynConfig.ST_ConfigRecipeSet;	// the active recipe, kept over a restart
END_VAR

fb_Machine.m_Register(vio_Manifest := GVL_Config.stManifest, vi_udn_Id := 0);	// id 0: the machine
fb_Machine.m_DeclareField(vi_un_Field := 1, vi_str_Name := 'BeltSpeed', vi_udn_Group := fb_Infeed.m_Id(),
	vi_e_Type := SynConfig.E_ConfigFieldType.NUMBER, vi_str_Unit := 'mm/s', vi_lr_Min := 0, vi_lr_Max := 500,
	vi_lr_ProgramValue := 150);
fb_Machine.m_DeclareField(vi_un_Field := 2, vi_str_Name := 'Pattern', vi_udn_Group := 0,
	vi_e_Type := SynConfig.E_ConfigFieldType.CHOICE, vi_str_Unit := '', vi_lr_Min := 0, vi_lr_Max := 0,
	vi_lr_ProgramValue := 0);
fb_Machine.m_SetChoice(vi_un_Field := 2, vi_un_Value := 0, vi_str_Text := 'Lanes');
fb_Machine.m_SetChoice(vi_un_Field := 2, vi_un_Value := 1, vi_str_Text := 'Random');
fb_Machine.m_Cycle(vio_Set := RecipeSet, vi_b_ApplyAllowed := b_MachineStopped);
lr_BeltSpeed := fb_Machine.m_Value(vi_un_Field := 1);	// m_Integer, m_Switch for the other types

CASE fb_Machine.m_Command() OF
	SynConfig.E_ConfigCommand.START:
		fb_Machine.m_AnswerCommand(vi_b_Accepted := b_MachineStopped, vi_str_Reason := 'Not stopped');
	SynConfig.E_ConfigCommand.STOP, SynConfig.E_ConfigCommand.RESET:
		fb_Machine.m_AnswerCommand(vi_b_Accepted := TRUE, vi_str_Reason := '');
END_CASE
```

- Fields are numbered from 1 and listed up to the highest one declared. The gateway reads the declarations when it
  discovers the PLC: declare every field from the start, and keep their order (the persistent recipe keeps values by
  index; add new fields at the end).
- An active recipe saved before a field was added gives that field 0, not its program value: choose a field's values
  so that 0 keeps the machine as it was (the demo's `Pattern` has Scattered, its old pattern, as 0).
- `m_SetText(vi_un_Field, vi_str_Label, vi_str_Description)` (config protocol 4) gives a field the label the
  Simulator shows instead of its name put into words, and a description for its tooltip: free text in the operators'
  language; the name stays the field's key for writing and for recipe files.
- `m_SetVisibleWhen(vi_un_Field, vi_un_OnField, vi_dn_Value)` (config protocol 4) shows a field only while field
  `vi_un_OnField` (a SWITCH as 0 / 1, a CHOICE or an INTEGER field, in any group) has that value in the Simulator's
  form, e.g. a lane count only for the pattern Lanes; a field depending on a hidden one is hidden too, and
  `vi_un_OnField` 0 shows it always. A hidden field keeps its value and is written with the recipe. The gateway reports
  a condition on a NUMBER field, on the field itself, on a field not declared, on a value that field can never have or in a ring of fields as a discovery
  error and shows that field always.
- `m_Cycle` takes a staged recipe over only while `vi_b_ApplyAllowed`, on the active version it is based on, and only
  when every value fits its field (else REJECTED with the field's name); a reset returns to the program values.
- A machine command is a request: `m_Command` gives the waiting one, and the application alone decides with
  `m_AnswerCommand` whether it is carried out. The answer, with its reason, reaches the Simulator.
- Report simulation mode in the machine entry (Syn_Visu `_FB_VisuMachine.m_SetSimulation`) only where no real machine
  can move: without it the gateway writes no recipe and sends no command.

The demo wires it in `P_VisuDemoMachine`, called before the applications: its machine FB declares 16 fields (Infeed 1's
belt speed and acceleration, Delta 1's speed and acceleration in % and picks per cycle, and the product pattern: rate,
lanes and their pitch, type mix, X / Y / rotation scatter, gap share, seed, feed on / off and, as field 16, the
pattern Scattered or Lanes), each with a description and some with a label, the lane fields shown only for Lanes and
the scatter fields only for Scattered (`m_SetText`, `m_SetVisibleWhen`), copies the effective values
to `DEMO_GlobalVar.DEMO_Recipe` for `P_VisuDemoDelta`, answers Start (while stopped), Stop (while starting or running)
and Reset (while stopped), ramps Infeed 1 between 0 and the recipe's speed (STARTING, RUNNING, STOPPING, STOPPED) and
reports the run state, simulation mode and two machine messages to Syn_Visu. `P_VisuDemoDelta`'s product generator
(`m_Generate`) makes up raw detections from the pattern with deterministic pseudo-random numbers from the seed (the
rate counts places a minute at the recipe's belt speed), which its tracking latches as Vision 1's (`m_Track`);
Delta 1 moves as fast as its belt and recipe allow (`m_Delta1Step`), so it halts with it; Reset empties Infeed 1,
drops what any robot approaches or carries of it, starts the generator from its seed again and acknowledges Delta 1's
fault (`m_Reset`); a product passing Infeed 1 unpicked raises "Product missed" (`m_Missed`). The demo starts
running with the program values, which give the product pattern it had before its recipe.

The demo (`plc/Syn_Visu_Demo`) does this for Infeed 1, Delta 1 and Vision 1 (`P_VisuDemoDelta`; the vision system
latches its products under its effective lens position) and the IDH XTS gantry (`P_VisuDemoIdh`; its simulated motion
keeps to the program's track), taking a set over at once; the gateway tests emulate the same (`apps/gateway/src/config-emulation.ts`).
