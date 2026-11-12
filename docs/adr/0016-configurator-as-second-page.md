# The configurator is a second page of the web app, editing a draft

The visualisation only mirrors what the PLC reports. The configurator (RPP_Configurator) goes the other way: a
commissioning engineer places the machine's components in 3D, gives them zones, grippers and product types, and
later writes the result to the PLC as the parameters the application runs with. The configuration in Syn_Visu is
already the description of the machine the application uses, so the configurator edits exactly that and nothing
else: a component's configuration as the protocol defines it (`ComponentConfig`).

It is a second page of `apps/web` (`configurator.html`, served by the gateway at `/configurator`) rather than an app
of its own or a mode of the visualisation. It draws a machine with the same kits, views and `SceneView` as the
visualisation, so a component looks the same in both and a new component type is drawn by the configurator without
code of its own. Two pages share the library chunks and none loads the other's code.

What is edited is a **draft**: a JSON file (`DraftSchema` in `@rpp/protocol`, format `rpp-draft`) holding every
component's configuration with its source and manifest id. The configurator works offline first: a draft is made,
saved and opened without any PLC. Every component of a draft is turned into an ordinary `config` message per source
and drawn by `buildMachineScene` without a state (robots at rest). The `Configurator` (`src/configurator/`) holds
the draft, the selection, undo and redo (a drag in the 3D view is one step), the draft file and the problems found
(`validateDraft`); every change is an edit applied by the pure `applyEdit`. It is the seam the tests use, as the
`Viewer` is for the visualisation.

## Considered Options

- **A separate app `apps/configurator`** with the 3D code moved to a shared package first. Cleaner apart, but the
  move is a large change before anything is gained; the shared code can still move once the boundary hurts.
- **One page with a visualisation and a configurator mode.** The visualisation runs on panel PCs that must never
  offer editing; two pages keep the configurator's code off them.
- **A draft model of its own** instead of the protocol's configuration. It would need its own mapping to the scene
  and to the PLC, and could describe things the PLC cannot hold.

## Consequences

- The palette offers conveyor and Delta robot first; their hardware geometry (arm lengths and the like) is assumed
  until a PLC reports its own. Zones, product types, grippers, the other component types, importing from a PLC and
  writing to it follow in their own steps.
- The handles that edit the draft in 3D (moving a component, a zone's start, end, CCS and sides) are drawn by the
  configurator inside `SceneView`, not as `SCENE_PARTS`: they exist only for the selected component, follow the draft
  rather than a PLC state and would only burden the visualisation's scene model. A product type's preview is an
  ordinary product of a state the draft makes up, so the kits draw it.
- Zone warnings follow one rule in `machine-facts.ts` (`zoneWarnings`) for the visualisation's scene and the
  configurator's problems.
- Writing a draft to a PLC needs a writable parameter set in Syn_Visu that the application takes over itself; that
  decision gets its own ADR.
- Unknown paths still fall back to the visualisation; a path naming a page of the built app (`/configurator`) is
  served that page.
