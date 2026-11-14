# Adding a component type

First decide which kind it is (ADR 0007):

- **Drawn from bodies**: the visualisation only shows where it is, with its zones and a fault (a vision system, a
  sensor, a printer, a reject gate). It describes itself as bodies and needs no drawing code. First choice whenever it
  is enough; often no new type is needed at all: a part working on products at a conveyor is a **station**.
- **Own drawing**: its look follows from logic the visualisation computes (kinematics, movers on a track, a register).

PLC steps go through the TwinCAT MCP tools. The compiler asks for most table entries (`satisfies` over every
`ComponentType`); a test checks that the configurator's palette offers every type.

## Drawn from bodies

1. **Syn_Visu**: a value in `E_VisuComponentType` (append, never renumber); an FB `EXTENDS _FB_VisuDetector` or
   `_FB_VisuBodyComponent` with `m_ComponentType` and an `m_Configure` describing its bodies (`m_SetBody`; something
   lighting up: `m_SetBodyActive`). A detector reuses `ST_VisuDetector`; a type of its own copies `ST_VisuStation`.
2. **Protocol** (`model.ts`): `componentConfig("<type>", bodyComponentConfig(), "<description>")`,
   `componentState(...)` and its `COMPONENT_SCHEMAS` entry (see "Configurator and parameter sets" for its fields).
3. **Gateway**: the `E_VisuComponentType` value in `plc-contract.ts`; its `COMPONENTS` entry (manifest value, contract
   structure, parameter FB structure); its structure in `PlcStructures` (`plc-builders.ts`).
4. **Machine view**: `<type>: bodyKit()` in `KITS` (`scene-model.ts`).
5. **Tests**: config and state arrive (`gateway.test.ts`).

## Own drawing

1. **Syn_Visu**: the `E_VisuComponentType` value; contract structures `ST_Visu<Name>` with `stConfig` and `stState`,
   named as `docs/plc-contract.md` requires so the gateway maps them without code; an FB `EXTENDS _FB_VisuRobot`
   (zones and fingers come with it), `_FB_VisuXtsTrack` (modules and their faults), `_FB_VisuZoneComponent` or
   `_FB_VisuComponent`; its `m_Pose` names where `m_SetPose` writes, `m_Configure` takes only hardware.
2. **Protocol**: config and state schemas (`robotConfig` / `componentConfig`, `componentState`) and their
   `COMPONENT_SCHEMAS` entry. Field names are the PLC members without their prefix; every field gets `.describe()`.
3. **Gateway**: the TypeScript mirror in `plc-contract.ts`, the `COMPONENTS` entry, a builder and `PlcStructures`
   entry. Mapping exceptions are registered in `plc-mapping.ts` (`registerEnumTable`, `ALIASES`), not hand-written.
4. **Machine view**: a kit in `scene/kits/` registered in `KITS` (`build` through the context: `addZones`,
   `addGripper`, `addFault`, carriers, snap points; `interpolate` blends two states). A new kind of part: its list in
   `SceneModel`, its `SCENE_PARTS` entry, its mesh in `scene/views/` and its `PART_VIEWS` entry. Inspector, timeline
   and recording need nothing. A robot with a limit area calls `addLimitArea` and gets a `ROBOT_TCPS` entry
   (`machine-facts.ts`); its kit draws the flange by the same rule, so drawn flange and checked TCP agree.
5. **Demo and fixture**: an instance in `Syn_Visu_Demo` (`docs/demo-plc.md`) and one in
   `apps/gateway/test/fixture-machine.ts`.
6. **Tests**: config and state arrive; `buildScene` tests for what it draws.

## Configurator and parameter sets (ADR 0016, 0017)

1. **Protocol**: the `COMPONENT_SCHEMAS` entry lists its `parameters` (pose, origin shift and what is set up per
   machine: zones, product types, track modules, fingers, areas), its `hardware` (lengths, arm geometry, strokes,
   bodies) and its `parameterDescription`.
2. **Syn_Config**: `ST_Config<Type>Param` with exactly those members, `ST_Config<Type>Set`, `ST_Config<Type>`
   (`vo_Config`) and `_FB_Config<Type> EXTENDS _FB_ConfigComponent` (`m_ComponentType`, `m_Cycle` through
   `m_HandleStaging`, `m_InvalidStaged`, `m_PassOn` with the pose, `m_Pose`, `m_Active`; zones, areas and modules
   through the base's helpers). A body component derives from `_FB_ConfigBodyComponent` and adds only
   `m_ComponentType` and `m_PassOn`. Bump the minor version, export it.
3. **Gateway**: `plcConfigType` in its `COMPONENTS` entry; discovery, writing and emulation need no code.
4. **Configurator**: `PALETTE_TYPES`, `PALETTE_LABELS` and `defaultComponent` with assumed hardware
   (`component-defaults.ts`); a new kind of list needs its `AddEntry` and an add command; an optional area its
   `defaultArea`; a robot with fingers its rest state (`rest-states.ts`) and the flange frame passed to `addGripper`.
5. **Tests**: the gateway write test (`parameters.test.ts`, `it.each` over the types) and
   `configurator-types.test.ts` for a new editor.

## Docs and release

Update `docs/plc-contract.md`, the guide (`docs/plc-library-guide.md`), `docs/config-contract.md`, `GLOSSARY.md`
and the area rule in `.claude/rules/` that changes. A contract change is a protocol change: bump `PROTOCOL_VERSION`
and `VISU_un_PROTOCOL_VERSION` together and release the library (`docs/plc-contract.md`, "Releasing a version").
