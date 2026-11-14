---
paths:
  - "apps/configurator/**"
---

# Configurator (`apps/configurator`, served at `/configurator/`, ADR 0016)

Edits a draft of a machine offline or against its PLCs, and writes parameter sets to them. View state:
`useMachineView("rpp.configurator.view", LAYERS)` (coordinate systems on).

## Seam: `Configurator` (`src/configurator.ts`)

- **Draft**: `DraftSchema` in `@rpp/protocol`, every component's `ComponentConfig` with source and manifest id, saved
  as `<name>.rpp-draft.json` (save, open, new; unsaved changes are discarded only after `confirmDiscard`).
- **Edits**: every change is an edit applied by the pure `applyEdit` (`edits.ts`; a path may name list entries by
  index, e.g. `["zones", "1", "end"]`). Undo and redo; a drag between `beginGesture` / `endGesture` is one step.
- **Problems** (`validation.ts`, `validateDraft`): errors such as an id used twice, a zone on a conveyor neither the
  draft nor its PLC has, a track module without a length, a finger without diameter or height; warnings such as
  machine-view's `zoneWarnings` or an XTS loop that does not close. Counted in the status bar; a click selects.
- **Adding**: the palette (`component-defaults.ts`: every type with assumed hardware) places by click or drop on a
  10 mm grid. Zones on a conveyor of the same source (`addZone`, dragged edge by edge with `dragZone`, belt
  coordinates by `belt-coordinates.ts`), product types (`addProductType`), track modules (`addModule`, 250 mm),
  bodies (`addBody`), areas (`addArea` from `defaultArea`, `removeArea`), list entries removed by `removeListEntry`.
- **Gripper**: laid out in a top view of the flange (`FingerLayout.tsx`; `addFinger`, `moveFinger` on a 5 mm grid, one
  undo step per drag); a draft robot with fingers is drawn at rest (`rest-states.ts`, ADR 0018).
- **Drawing**: `frame()` gives the draft as `SceneSource`s (a preview product per product type, rest states), drawn by
  the visualisation's kits. `EditControls.tsx` (children of `SceneView`) holds the move and zone handles and the floor
  picker; the move handle snaps to other components' snap points.
- **Properties** come from the config schema (`property-fields.ts`): values, nested objects, list entries as groups,
  optional areas named in `optionals`, a zone's conveyor chosen from the source's conveyors.

## Online (machine-view's `GatewayLive`; `start` / `stop`)

- Imports a source (`importSource`, one undo step) or a component only the PLC has (`importComponent`).
- Reconciles the draft with the PLCs (`reconciliation.ts`: matched / changed / draftOnly / typeMismatch / noPlc,
  `plcOnly`); draws matched components live and the PLC's version of changed ones as a faded ghost (`ghostSourceId`).
- Hints where the draft assumed other hardware than its PLC has (`HARDWARE_FIELDS`, `hardwareHints`;
  `adoptPlcHardware` takes the PLC's).
- **Writing** (`writing.ts`): `writePlan(sourceId)` lists the changed parameter values (`leafChanges` against the
  active set) or why the source is blocked (`writeBlockedReason`, or errors in the draft); `write` stages every changed
  component on its active version; `resetParameters` returns one to its program values; `writes` shows how each fares.
  `wiringHints` warn where the visualisation shows other values than the active set; `unwritableHints` name changed
  components without a parameter set.
