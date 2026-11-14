# Adding a component type

What a new kind of machine part needs, from the PLC to the 3D view. First decide which of two kinds it is.

- **Drawn from bodies.** Anything the visualisation only has to show where it is, with its zones and a fault: a
  vision system, a sensor, a printer, a scale, a reject gate. It describes itself as bodies (boxes, cylinders,
  frustums with a role), and the web app draws it without knowing it. This needs no drawing code (only the type's
  line in `KITS`) and is the first choice whenever it is enough. Often no new type is needed: a part that works on
  products at a conveyor is a **station** (`_FB_VisuStation`), described by the application's own `m_SetBody` calls.
- **Own drawing.** Anything whose look follows from real logic the visualisation has to compute: kinematics (the Delta's
  arms from its TCP), movers along a track, a product register. It gets its own scene kit and mesh.

ADR 0007 explains the split.

## Drawn from bodies

Examples: the vision system and the product sensor, which share everything except their `m_Configure`, and the
station, which has its own structure with the same members.

1. **PLC library** (`plc/Syn_Visu`, edited only through the TwinCAT MCP tools):
   - a value in `E_VisuComponentType` (append, never renumber);
   - a function block `EXTENDS _FB_VisuDetector` (a detector) or `EXTENDS _FB_VisuBodyComponent` (anything else) with
     `m_ComponentType` and an `m_Configure` that describes its bodies with `m_SetBody` (and, if something lights up, a
     method that calls `m_SetBodyActive`); bodies, zones, fault and origin shift come with the base, which only needs
     to know where they lie (`m_Parts`, `m_Zones`);
   - a detector reuses `ST_VisuDetector`; a type of its own gets a structure with the same members, like
     `ST_VisuStation`.
2. **Protocol** (`packages/protocol/src/model.ts`): `componentConfig("<type>", bodyComponentConfig(), "<description>")`
   and `componentState("<type>", bodyComponentState(), "<description>")`, and one entry in `COMPONENT_SCHEMAS`, from
   which both unions follow. The descriptions appear in `/docs/schema.json` (ADR 0012).
3. **Gateway**: the `E_VisuComponentType` value in `plc-contract.ts`, one entry in `COMPONENTS` (`components.ts`) with
   that value and the contract structure, and for tests its structure in `PlcStructures` (`plc-builders.ts`). The
   compiler asks for both entries.
4. **Machine view** (`packages/machine-view`): one line in `KITS` (`scene-model.ts`): `<type>: bodyKit()`
   (`scene/kits/bodies.ts`).
5. **Tests**: a gateway test that the config and state arrive (`gateway.test.ts`).
6. **Docs**: `docs/plc-contract.md`, the guide's sections and reference (`docs/plc-library-guide.md`), `GLOSSARY.md`
   for the new term, and `CLAUDE.md` when the architecture summary changes.

## Own drawing

Example: the Cartesian robot.

1. **PLC library**: a value in `E_VisuComponentType`; the contract structures `ST_Visu<Name>` with `stConfig` and
   `stState`, named as `docs/plc-contract.md` ("Naming of the contract structures") requires, so the gateway maps them
   without code; a function block `EXTENDS _FB_VisuRobot` for a robot (zones and fingers come with it, it only reports
   where they lie through `m_Zones` and `m_Fingers`), `_FB_VisuXtsTrack` for one whose movers run on an XTS track
   (modules and their faults come with it, through `m_Modules`), `_FB_VisuZoneComponent` for anything else with
   zones, or `_FB_VisuComponent`.
2. **Protocol**: the config and state schemas with `robotConfig` / `componentConfig` and `componentState`, and their
   entry in `COMPONENT_SCHEMAS` (the compiler checks that the key is the schemas' `type`). Field names are the PLC
   members without their prefix. Every schema and field gets a `.describe()` text for `/docs/schema.json`; a test
   fails for a field without one (ADR 0012).
3. **Gateway**: the TypeScript mirror of the structures and the `E_VisuComponentType` value in `plc-contract.ts`,
   one entry in `COMPONENTS`, a builder and its `PlcStructures` entry in `plc-builders.ts`. If a value needs more than
   the naming rules (an enum that does not count from 0, a member named differently), register it in `plc-mapping.ts`
   (`registerEnumTable`, `ALIASES`) rather than writing a mapper.
4. **Machine view** (`packages/machine-view`, drawn the same in both apps):
   - a kit in its own module in `scene/kits/` (e.g. `cartesian.ts`; the XTS gantry and loop share the track layout in
     `xts-track.ts`), registered in `KITS` (`scene-model.ts`); the shared kit vocabulary is in `kits/kit.ts`. `build`
     adds its parts through the build context (`addZones`, `addGripper`, `addFault`, carriers for products it carries
     (`carrierKey`), snap points) and `interpolate` blends two states;
   - for a new kind of part: its type, a list for it in `SceneModel` and its entry in `SCENE_PARTS` (which component
     owns a part, for hiding, and what of it changes the drawn objects), its mesh in the type's module in
     `scene/views/` (e.g. `cartesian.tsx`; XTS gantry and loop share `xts.tsx`; shared mesh helpers in `common.tsx`)
     and its entry in `PART_VIEWS` (`SceneView.tsx`). The compiler asks for both entries; the empty scene, hiding and
     the structural signature follow.
   The inspector (`stateRows`), the timeline (faults of the entries of any list in the state, e.g. movers or track
   modules) and the recording need nothing. A part with its own fault is passed to `addFault` with its name
   ("Mover 2", "Module 9");
   - a robot with a limit area (`limitedRobotConfig`; in the PLC `m_LimitArea` gives both boxes) calls `addLimitArea`
     in its kit and needs an entry in `ROBOT_TCPS` (`machine-facts.ts`) saying where its TCPs lie in its frame (the
     compiler asks for it); its kit draws the flange from the same rule (like `gantryFlange`, `cartesianFlange`), so
     drawn flange and checked TCP agree.
5. **Demo and fixture**: an instance in the demo application `Syn_Visu_Demo` (through the TwinCAT MCP tools), so the
   dev gateway and the browser tests show it (`docs/demo-plc.md`), and one in the gateway tests' fixture machine
   (`apps/gateway/test/fixture-machine.ts`), whose messages the docs page test checks against the JSON Schema.
6. **Tests**: the gateway test for config and state, `buildScene` tests for what it draws.
7. **Docs**: as above.

## Configurator and parameter sets

Every type also needs its place in the configurator (ADR 0016) and a parameter set in Syn_Config (ADR 0017). The
compiler asks for most of these entries (`satisfies` over every `ComponentType`), and a test checks that the
palette offers every type of `COMPONENT_SCHEMAS`.

1. **Protocol** (`packages/protocol/src/parameters.ts`): its fields in `PARAMETER_FIELDS` (pose, origin shift and what
   the application sets up per machine: zones, product types, track modules, gripper fingers, areas; never hardware), its schema in
   `PARAMETER_SCHEMAS` and `typed("<type>")` in `TypedParametersSchema`.
2. **Syn_Config** (`plc/Syn_Config`, through the TwinCAT MCP tools): `ST_Config<Type>Param` with exactly those members
   (named as in its Syn_Visu config), `ST_Config<Type>Set`, `ST_Config<Type>` (`vo_Config`), and
   `_FB_Config<Type> EXTENDS _FB_ConfigComponent` with `m_ComponentType`, `m_Cycle` (as the other FBs),
   `m_Invalid`, `m_PassOn`, `m_Pose` and `m_Active`; zones, limit areas and track modules go through the base's
   helpers (`m_InvalidZones`, `m_PassOnZones`, ...). A component drawn from bodies derives from
   `_FB_ConfigBodyComponent` and only adds `m_ComponentType` and `m_PassOn`. Bump the library's minor version and
   export it; `docs/config-contract.md` lists the structures.
3. **Gateway**: the structure's mirror and its `PLC_CONFIG_TYPES` entry in `config-contract.ts`; discovery, writing
   and the emulation follow the naming convention without code.
4. **Configurator** (`apps/configurator`): its `PALETTE_TYPES` and `PALETTE_LABELS` entry, its `defaultComponent`
   with assumed hardware and its `HARDWARE_FIELDS` (`component-defaults.ts`); a new kind of list needs its `AddEntry`
   and a command that starts an entry (like `addModule`, `addBody`, `addFinger`), an optional area its `defaultArea`. A
   robot with fingers needs its rest state in `rest-states.ts` (where the draft draws its flange, ADR 0018); its kit
   passes the flange frame its fingers' offsets count from to `addGripper`.
5. **Tests**: its gateway write test (`parameters.test.ts`, the `it.each` over the types) and a configurator test per
   new editor (`configurator-types.test.ts`).

## Releasing

A change to the contract is a protocol change: bump `PROTOCOL_VERSION` and `VISU_un_PROTOCOL_VERSION` together, and
release the library (`docs/plc-contract.md`, "Releasing a version").
