# PLC coding guidelines

Summary of the company guideline "TCAT Programmierrichtlinien 2018" (v1.6, 2024, Syntegon). It describes how TwinCAT PLC projects are named, structured and formatted so that programs and program parts stay exchangeable. The guideline distinguishes **rules** (binding) from **guidelines** (should be followed). Rules are marked **(rule)** below.

## Relation to this repo

The `Syn_Visu` library (`plc/`) follows this guideline: `_FB_Visu*` function blocks, `m_` methods, `vi_`/`vo_`/`vio_` inputs and outputs, `Temp` method locals, `VISU_GlobalConst` / `VISU_GlobalConst_Param` with upper-case constants, copyright and help headers. **Exception:** the PLC contract keeps its Beckhoff-style names (`ST_Visu*` structures and their members such as `stConfig`, `bActive`, `fX`, the `E_Visu*` enums and `GVL_Visu.stManifest`), because the gateway reads them (`docs/plc-contract.md`, `apps/gateway/src/plc-contract.ts`); renaming them would be a protocol change. The folder scheme (`01_Version` ... `99_Visualizations`) and the task and program names apply to machine projects, not to the library.

## General

- **(rule)** Everything in the source is English: names and comments. Only temporary `///` comments may be German.
- Only Structured Text (ST) is used.
- Every POU (program, FB, function, method, action of a `_Main` SubUnit) starts with the copyright header:

  ```
  © Syntegon Group.
  All rights reserved, also regarding any disposal, exploitation, reproduction, editing, distribution,
  as well as in the event of applications for industrial property rights.
  ```

## Project and hardware names

- Project archive: `J_xxxxx_McName_yyy[Tozzz]_TCATn.tszip`, for example `J_02204_FIFD_001To004_TCAT1.tszip`. A customer project is created by opening the archived master project in a new customer folder and renaming the solution and project folders (not Save As).
- Hardware is named so it can be found in the electrical schema:
  - Ethernet ports: as labelled on the device.
  - Racks (couplers, boxes): `r[xx]_[SchemaName_][Rackr] (BeckhoffType)`, for example `1xx_INF1_Rack1 (EK1100)`.
  - Terminals: `rSlot_[SchemaName_][Rackr]_[MODx_][UNITx_]Id (BeckhoffType)`, for example `102_FIT_Rack1_Di (EL1018)`. The `rSlot` number equals the safety ID where safety terminals are used. Keep the space before the bracketed Beckhoff type.
  - Ids: `Di`, `Do`, `Ai`, `Ao`, `Rackx_Dio`, `FastDi`, `SDi`, `BrakeChopper`, `Licence`, `End`, `PowerSupply`, `EthernetIP`, `EtherCATJunction`, `EthernetSwitch`, `Drive`.
- Drives have the same name as their axis object in MOTION plus `_Drive`: `rSlot/SafID_MODx_UNITx_[SubUnit_]ax[Diff]_Drive (BeckhoffType)`. On 2-channel drives both axis names are joined with `+` and only the second gets `_Drive`. Free channels are named `Reserve`.
- XTS objects share one stem per XTS, `MODx_UNITx_SubUnit` (usually `..._EmtCtr`), with the suffixes `_ax1.._axY`, `_ConnectionX`, `_MultiplierXPortY`, `_MotorX` and `_FeedbackX`.
- Tasks: `TASKNAME_Task_Spec`, where `TASKNAME` is `CONT`, `PERIODIC` or `EVENT`. Periodic speeds are `VerySlow`, `Slow`, `MediumSlow`, `Medium`, `MediumFast`, `Fast` and `VeryFast`, for example `PERIODIC_Task_Fast`.

## Program structure

Hierarchy: System (90) → Platform (80) → Module (70, e.g. `INF`, `WRP`) → Unit (60, e.g. `BLT`, `FIT`) → SubUnit (FB with suffix `_Main`).

Top-level folders of the application project:

| Folder | Content |
| :--- | :--- |
| `01_Version` | software version numbers |
| `10_TaskScheduler` | one program per module and task: `MODx_Program_TaskSpec`, e.g. `INF1_Program_Slow` |
| `20_Programs` | SubUnit containers. Each calls its SubUnits in actions named `UNITx_[SubUnit_]Main`. |
| `30_SubUnits` | SubUnit FBs with subfolders `Datatypes`, `Enums`, `GlobalConst`, `POUs`, `VisuElements` |
| `31_Functions` | reusable FBs and functions |
| `40_GlobalVariables` | interface signals between SubUnits and to the HMI |
| `41_GlobalConstantsAndEnums` | project-specific constants and enums |
| `98_Simulations` | code that only exists to test without hardware |
| `99_Visualizations` | active visualisation pages |
| `PACB` | shared PACB SubUnits and functions |

- **(rule)** A `_Main` SubUnit has the same base name as the folder that holds everything belonging to it.
- A SubUnit is programmed once, regardless of how many times it is instantiated. Its instance has a head (`fb_..._SubUnitHead`), a local interface copy `LIc`, and is called at the end of its program section with all interface signals.
- In `31_Functions`, first-level folders use upper-case abbreviations. Keep at most 20 folders per level and at most 20 POUs per folder.
- Customer-specific changes to PACB blocks: rename the block with refactoring to `..._Spec` and move it into a folder `PACB_Spec`.

## Naming

### Basic data type prefixes

| Prefix | Type | Prefix | Type |
| :--- | :--- | :--- | :--- |
| `b` | BOOL | `usn` | USINT |
| `by` | BYTE | `un` | UINT |
| `w` | WORD | `udn` | UDINT |
| `dw` | DWORD | `r` | REAL |
| `sn` | SINT | `lr` | LREAL |
| `n` | INT | `str` | STRING |
| `dn` | DINT | `time` | TIME |
| `date` | DATE | `dayt` | TOD |
| `datet` | DT | `dctime64` / `dctime32` | T_DCTIME64 / T_DCTIME32 |
| `e` | ENUM | `p` | POINTER TO |
| `ax` | AXIS_REF | | |

Begin the name with its characteristic part (unit, kind, place) so autocompletion groups related variables, for example `lr_DistXyz`, `lr_TempXyz`.

### Variables and constants

| Kind | Pattern | Example |
| :--- | :--- | :--- |
| Local variable | `t_[Temp]Name` | `b_EnableAxis`, `lr_TempDistMaster` |
| Global variable | `MODx_UNITx_[SubUnit_]t_[i\|o]Name` | `INF1_PGR1_b_iProductSensor` |
| Global variable container | `MODx_UNITx_[SubUnit_]GlobalVar` | |
| Local constant | `t_CONSTANT_NAME` | `dn_MAX_LIGHT_CYCLES` |
| Global constant | `PREFIX_t_CONSTANT_NAME` in `PREFIX_GlobalConst[_AddInfo]` | `MATH_lr_PI` in `MATH_GlobalConst` |
| Local DUT variable | `[e_][Prefix]Name` (no type prefix; `In`, `Out`, `CamTable`, `CamPoints`) | `InControl`, `e_HomeSeq` |
| Global DUT variable | `MODx_UNITx_[SubUnit_]Name` | `INF1_PGR1_Hmi` |
| HMI button in a Cmd struct | `BtnName` (type `TCmdButtonSwitch_Data`) | `Cmd.BtnClean` |

- Global constants describe mechanical, mathematical or physical facts. Do not use them to bypass interfaces between SubUnits.

### Enumerations

- **(rule)** Every enum has `{attribute 'qualified_only'}` and `{attribute 'strict'}`. Leave out `strict` only if the enum is extended locally.
- **(rule)** Assign explicit values, from 0 to 99. Local extensions start at 100 and have the same name stem, written as `ENUM_NAME_VALUE` without the dot.
- Value names are upper case without a type prefix (`INIT`, `OPEN_GEAR`). Type names are `[PREFIX_][RoutineName_]ENUM_NAME`, for example `SM_STATE` or `EmtCatchUp_SEQ`. The base type stays INT.
- Enums that must be extendable with `EXTENDS` are modelled as structs of unique DINT constants. Their variables are declared `VAR CONSTANT` with upper-case names.

### Data types (DUTs)

- SubUnit types: `T[PREFIX_][UNIT_]SubUnit_TypeName[Sub]`. The defined type names are `Cfg`, `Cmd`, `ErrIface`, `Hmi`, `Iface`, `LIc` and `LIcInputs`. Examples: `TVAx_Iface`, `TLUB_Cfg`.
- Function types: `T[BlockName_]TypeName[Sub][_AddInfo]`, using `In`, `InData`, `InConfig`, `Out`, `Hmi`, `HmiPart`, `Reg` and `RegEntry`. Example: `TCamAnalyse_Out`.
- **(rule)** A DUT that belongs to one block contains that block's name, because DUT names must be unique in the project.

### POUs

| Kind | Pattern | Example |
| :--- | :--- | :--- |
| SubUnit FB | `_FB_[PREFIX_][UNIT_]SubUnit_Main` | `_FB_VAx_Main` |
| SubUnit instance | `fb_[MODx_]UNITx_[SubUnit_]Main` | `fb_FIT1_EmtCtr_Main` |
| Function block | `_FB_BlockName[_AddInfo]` (category prefix from its folder) | `_FB_EmtCrashCheck` |
| FB instance | `fb_BlockNamePlus` | `fb_CylinderBrake`, `fb_MoveVelocity1` |
| Button/switch instance | `fb_BtnName` | `fb_BtnMoveOneDir` |
| Function | `_FC_FunctionName` | `_FC_ErrorEntry` |
| Method | `m_MethodName` | `m_GetPivotAngle` |
| Action | `act_ActionName` | `act_Sequencer` |
| Jump label | `lbl_JumpName` (only `lbl_End`) | |
| Active visu page / template | `Visu_...` / `V_...` | |

- Standard action names: `act_AxCommands`, `act_AxControl`, `act_CalcOffline`, `act_CalcOnline`, `act_Cmd`, `act_Error`, `act_SuList`, `act_Home`, `act_Prod`, `act_Service`, `act_Iface`.
- Timers, counters and edge triggers: `ton_`, `tof_`, `tp_`, `ctu_`, `ctd_`, `ctud_`, `osr_` (R_TRIG), `osf_` (F_TRIG).
- Methods replace actions when the input/output interface is small. They are also used to override behaviour in `EXTENDS` derivations.
- **(rule)** All local variables of a method start with `Temp` (`lr_TempAngle`), to tell them apart from the FB's variables.

### Inputs and outputs

Pattern: `vi_` / `vo_` / `vio_` + `[t_]Name`, for example `vi_b_Init`, `vi_Data`, `vo_str_ErrorText`.

- **(rule)** Never write to `vi_` inputs inside the block.
- Work directly with the block's inputs and outputs at the call site to avoid copying. `VAR_IN_OUT` works by reference.
- SubUnit FBs have the following interface:
  - `vi_LIc`.
  - `vi_Cfg`, used through `REFERENCE TO`.
  - `vio_SM`, `vio_Cmd` and `vio_ax`. Axes are always passed as `VAR_IN_OUT`.
  - `vo_Iface`, copied to the global variable so the interface stays consistent.
  - `vo_ErrIface` and `vo_Hmi`, which the globals only reference. Never use them as interface signals.
  - `vo_Outputs`.
- **(rule)** Never read local variables of a POU from outside through its instance path. Use outputs.
- FB calls list all inputs and outputs, even unconnected ones. Keep the formatting that F2 produces (no space before `:=` / `=>`).
- **(rule)** Function calls may use the short form (no input names) only with at most 4 inputs, and only for frequently used functions, on one line.
- **(rule, this repo)** Methods are always called with every input, and method inputs have no default values (`vi_lr_Y : LREAL;`, not `vi_lr_Y : LREAL := 0;`). Default values of method inputs that a call leaves out work only from TwinCAT 3.1 Build 4026; machine projects on 4024 must compile `Syn_Visu` and their own calls. Without defaults the 4026 compiler reports every incomplete call too ("requires exactly n inputs"). Say in the input's comment which value means "none", e.g. `// [mm] ..., 0 = none`.

## Comments

- **(rule)** End-of-line comments use `//`. Comments that take whole lines use `(* *)`.
- **(rule)** Each block's declaration starts with a help header of fixed width (lines end in `<br>`):
  - the copyright;
  - `DESCRIPTION` (mandatory);
  - optionally `PARAMETERS`, `INPUT VALUES`, `OUTPUT VALUES`, `LIMITS` and `ERROR DESCRIPTION`;
  - a version history using the overall software version (master `PACB 2.00.01`, customer `C1.001`).

  Methods, FB actions and programs have no version history. Actions of `_Main` SubUnits do have one.
- Comment inputs and outputs, constants and DUT members after the declaration, with the unit first in brackets (`// [mm] ...`).
- **(rule)** Main sections have an upper-case title between two lines of asterisks, with 2 blank lines before the section. A main section has at most 100 lines. Groups of related lines get a comment line and 1 blank line before them.
- Temporary comments and commented-out code are marked `///` (shown bold red; may be German) with date and name, so they can be found by searching. A `{warning '...'}` pragma can be added.

## Formatting

- Consolas 10 and a tab width of 4.
- **(rule)** Declarations are aligned in columns: name indented one tab, type at tab 10. This also limits the name length.
- Assignments are not aligned: `a := b;`, with one space before and after `:=`. Align with tabs only for FB calls copied from templates.
- **(rule)** Indent one tab for every `IF`, `FOR`, `WHILE` and `REPEAT`. `CASE` labels are indented, and their statements one more tab.
- At most 5 nesting levels; move deeper code into actions.
- At most 4 logical operators in a row.
  - **(rule)** When conditions are split over several lines, each line continues directly under the `IF`, without an indent.
  - **(rule)** Conditions assigned to a variable continue at the column of `:=`.
- Put a space around every operator; you may drop it to group, for example `a*b/c`.
  - **(rule)** A calculation that wraps starts the next line with the operator, aligned under `:=`.
- A POU has at most 1000 lines (except data assignments), and a line at most 150 characters.
- Avoid `JMP`. It is used only as `lbl_End` in the SysFail case.
- Use `AND_THEN` / `OR_ELSE` only where short-circuiting is needed, for example for pointer or NaN guards. Do not use them everywhere.

## Visualisation and versioning

- Visualisation elements use a 40×40 px grid. Buttons and fields are 30 px high, with 10 px between them, and templates start at 0,0.
- TabControl pages are 1000×920 px on a white background rectangle, with the control set to 1006×948 px. Turn on the editor grid with step 5.
- Version numbers live in `01_Version`. The PLC version shown on the HMI is `TTCAT1_Version` (`ARRAY[0..3] OF STRING`) in the GVL `TCAT1_Version`, read through `Version_TCAT1_Hmi`.
