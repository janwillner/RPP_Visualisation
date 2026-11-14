---
paths:
  - "apps/simulator/**"
---

# Simulator (`apps/simulator`, served at `/simulator/`, ADR 0020, 0022)

Sets a machine's recipe and sends Start / Stop / Reset; the sequence control stays in the PLC application, and the
Simulator writes only while the machine reports simulation mode. Layout: 3D view and component tree as in the
visualisation; on the right the recipe form above the inspector (metrics while nothing is selected); at the top the
source choice, run state, commands with the application's answer and a link to the visualisation; in the status bar
the problems and the machine messages with the component faults. View state:
`useMachineView("rpp.simulator.view", LAYERS)`. Writing to the PLC: see the parameter-sets rule.

## Seam: `Simulator` (`src/simulator.ts`) on machine-view's `GatewayLive`

- **Source and selection**: the chosen source, else the first with a recipe.
- **Form** (`form`): the fields grouped by component, the machine's own fields last. Each has its label (the
  application's, else the name in words), whether it is visible (its condition holds with the values in the form,
  along the chain), its active and shown value, changed, an error from `invalidRecipeValue` (the gateway's rule too)
  and a warning from an opened file. A group is visible while one of its fields is. Hidden fields keep their edits,
  which are written and marked hidden in the write plan.
- **Edits** per source; an edit back to the active value is none. `problems` select the component whose field they
  are about; the selected component's group is marked (`selected`).
- **Writing**: `writePlan` (the changed values, or `blocked` from `writeBlockedReason`, or errors in the form),
  `write` (only the changed values, on the active version), `resetRecipe`, `discardEdits`. `GatewayLive` follows the
  write; applied values stop being edits.
- **Commands** (`commands`): Start while stopped, Stop while starting or running, Reset while stopped or in a fault,
  all only when not blocked; `command` in the snapshot follows the answer (sent, accepted, rejected, failed).
- **Messages**: the shown source's active machine messages (with id and time) and the faults the 3D view reports for
  it (`setFaults`), each selecting its component.
- **Recipe file** `<name>.rpp-sim.json` (`RecipeFileSchema`, format `rpp-sim`, values per source by group and field
  name): `save` (every source with a recipe, shown values); `open` after `confirmDiscard` when not saved, matching a
  source by id (or the only one with a recipe), fields by name; a value in another group is taken with a warning,
  unknown fields are skipped with a warning, missing ones keep their active value, differing ones become edits.

`SimulatorApp.tsx` only binds the Simulator to the page.
