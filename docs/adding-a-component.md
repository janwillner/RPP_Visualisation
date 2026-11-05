# Adding a component type

What a new kind of machine part needs, from the PLC to the 3D view. First decide which of two kinds it is.

- **Drawn from bodies.** Anything the visualisation only has to show where it is, with its zones and a fault: a
  vision system, a sensor, a printer, a scale, a reject gate. It describes itself as bodies (boxes, cylinders,
  frustums with a role), and the web app draws it without knowing it. This needs no web code at all and is the
  first choice whenever it is enough. Often no new type is needed: a part that works on products at a conveyor is a
  **station** (`_FB_VisuStation`), described by the application's own `m_SetBody` calls.
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
   and `componentState("<type>", bodyComponentState(), "<description>")`, added to both unions. The descriptions
   appear in the API documentation at `/docs` (ADR 0012).
3. **Gateway**: the `E_VisuComponentType` value in `plc-contract.ts` and its `PLC_TYPES` entry, one entry in
   `COMPONENTS` (`components.ts`), and for tests the `MachineComponent` entry in `plc-builders.ts`.
4. **Web**: one line in `KITS` (`scene-model.ts`): `<type>: bodyKit()`, and the type in `BodyComponentType`.
5. **Tests**: a gateway test that the config and state arrive (`gateway.test.ts`).
6. **Docs**: `docs/plc-contract.md`, `GLOSSARY.md` for the new term, and `CLAUDE.md` when the architecture summary
   changes.

## Own drawing

Example: the Cartesian robot.

1. **PLC library**: a value in `E_VisuComponentType`; the contract structures `ST_Visu<Name>` with `stConfig` and
   `stState`, named as `docs/plc-contract.md` ("Naming of the contract structures") requires, so the gateway maps them
   without code; a function block `EXTENDS _FB_VisuRobot` for a robot (zones and fingers come with it, it only reports
   where they lie through `m_Zones` and `m_Fingers`), `_FB_VisuXtsTrack` for one whose movers run on an XTS track
   (modules and their faults come with it, through `m_Modules`), `_FB_VisuZoneComponent` for anything else with
   zones, or `_FB_VisuComponent`.
2. **Protocol**: the config and state schemas with `robotConfig` / `componentConfig` and `componentState`, added to
   both unions. Field names are the PLC members without their prefix. Every schema and field gets a `.describe()`
   text for the API documentation at `/docs`; a test fails for a field without one (ADR 0012).
3. **Gateway**: the TypeScript mirror of the structures in `plc-contract.ts`, the `E_VisuComponentType` value and its
   `PLC_TYPES` entry, one entry in `COMPONENTS`, a builder in `plc-builders.ts`. If a value needs more than the naming
   rules (an enum that does not count from 0, a member named differently), register it in `plc-mapping.ts`
   (`registerEnumTable`, `ALIASES`) rather than writing a mapper.
4. **Web**:
   - a kit in `KITS` (`scene-model.ts`): `build` adds its parts through the build context (`addZones`, `addGripper`,
     `addFault`, carriers for products it carries, snap points) and `interpolate` blends two states;
   - its scene part type and a list for it in `SceneModel` and `emptyScene`, filtered for hidden components at the
     end of `buildScene`;
   - a mesh in `SceneView.tsx` and its line in the structural `signature`.
   The inspector (`stateRows`), the timeline (faults of the entries of any list in the state, e.g. movers or track
   modules) and the recording need nothing. A part with its own fault is passed to `addFault` with its name
   ("Mover 2", "Module 9").
5. **Simulator** (optional): an instance in `simulator.ts`, so the dev gateway and the browser tests show it.
6. **Tests**: the gateway test for config and state, `buildScene` tests for what it draws.
7. **Docs**: as above.

## Releasing

A change to the contract is a protocol change: bump `PROTOCOL_VERSION` and `VISU_un_PROTOCOL_VERSION` together, and
release the library (`docs/plc-contract.md`, "Releasing a version").
