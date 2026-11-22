# The configurator adds only the components its PLCs provide

ADR 0016 made the configurator offline first: a palette offered every component type, placed by a click or by
dragging it onto the floor, with its hardware assumed until a PLC reported its own. In practice the machine's
components are what the application registers in its manifest; a component the configurator made up has no PLC behind
it, cannot be written (no parameter set) and has hardware that is only a guess.

So the palette is gone. Components enter a draft only from a PLC: a whole source (`importSource`) or one component the
PLC has and the draft has not (`importComponent`), or from a draft file saved before. The configurator still edits
everything of a component that the protocol lets it: its pose, its zones, product types, fingers, track modules,
bodies and optional areas.

## Considered Options

- **Keep the palette for offline drafts.** It allows planning a machine before its PLC exists, but such a draft has
  to be matched to the PLC component by component later (source, manifest id and type by hand), and its hardware is
  wrong until then. Here the application comes first: a machine's components exist in its PLC program before they
  are configured.
- **Hide the palette while a PLC is connected.** Two ways to add would remain, and the offline one keeps the code
  for assumed hardware alive for little use.

## Consequences

- `Configurator.add`, the palette and its drop target in the 3D view are removed; so is the assumed hardware of every
  type (`defaultComponent`). The tests take their components from `test/sample-components.ts` instead.
- A draft can still be opened and edited offline; a new draft stays empty until a PLC's components are imported.
- Hardware hints (`hardwareHints`, `adoptPlcHardware`) remain: a draft saved earlier can hold other hardware than its
  PLC has now.
- A new component type needs no entry in the configurator to be added (`.claude/docs/adding-a-component.md`).
