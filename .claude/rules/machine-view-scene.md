---
paths:
  - "packages/machine-view/src/scene/**"
  - "packages/machine-view/src/palette.ts"
  - "packages/machine-view/src/machine-facts.ts"
  - "packages/machine-view/test/scene-*.test.ts"
  - "packages/machine-view/test/picking.test.ts"
  - "packages/machine-view/test/product-groups.test.ts"
---

# Machine view: the scene (`packages/machine-view/src/scene`)

## Seam: `buildScene` / `buildMachineScene` (`scene-model.ts`)

`buildScene(config, snapshots, renderTime, hidden)` is pure and builds one source's scene; `buildMachineScene(sources,
hidden)` builds every source on its own timeline and puts them side by side (snap points and faults across sources,
offline flag). It covers: hiding, interpolation by `tRel`, latch + belt product positions, the product display
lifecycle (normal / atTcp / placeholder / missed), Delta arms by inverse kinematics, XTS tracks laid out from their
modules, movers and carried products, Cartesian parts, gripper fingers, bodies from their PLC description (an active
body lights up), faults (red parts, labels, the per-component list), zones with allocation areas and CCS lines, origin
shifts, working / limit / TCP limit areas and limit violations (not checked while offline, ADR 0015), measure-mode
snap points, and MCS → renderer conversion `(x, y, z)mm → (x, z, −y)m`. Product snap points and TCP-limit-area
corners are built only in measure mode.

## Kits and parts

- Each component type is one kit in `kits/` (e.g. `delta.ts`; XTS gantry and loop share `xts-track.ts`, body
  components `bodies.ts`), registered in `KITS`; `build` goes through a shared context (zones, grippers, faults,
  carriers, limit areas), `interpolate` is optional; vocabulary in `kits/kit.ts`. `buildScene` knows no type.
- Meshes live per type in `views/` (shared helpers in `common.tsx`).
- Every kind of part is one entry in `SCENE_PARTS` (owner for hiding, what changes the drawn objects); the empty scene,
  hiding and `sceneStructure` follow. `PART_VIEWS` (`SceneView.tsx`) draws each kind. Both are typed over
  `SceneModel`, so a new kind cannot be forgotten.

## `SceneView.tsx`

Draws the scene sources of a moment (live, a recording, a draft), one group per source (faded while offline), and
updates transforms per frame via refs. React re-renders only when the set of objects changes: `scene-frame.ts` (pure)
gives per source a `SourceFrame` (structure changed?, parts by key, products by group) and a `MachineFrame`.

- Belt products are drawn per solid as one `InstancedMesh` with per-instance colours and instanced edge lines;
  `product-groups.ts` decides grouping and capacity (which only grows). Placeholders and carried products stay single
  meshes. A marked product takes its mark's colour while the layer "Product marks" is on; only the selection wins.
- Origin triads show on the layer `origins` and always in measure mode, and follow every frame.
- Pointer gestures → selections and measuring points (`picking.ts`): a `PressTracker` per gesture tells taps from
  drags, pinches and cancelled touches; `pickOnScreen` finds the snap point under the pointer.
- Measuring and fault props are optional; a page without them neither measures nor hears of faults.

## Look

Every colour lives in `palette.ts` (status colours also reach the panels as CSS variables, set in each app's
`main.tsx`; chosen for red-green colour blindness). Lit parts are matte with fine edge lines; overlays are unlit and
not tone mapped, so they keep their palette colour; areas have a solid outline. The stage is a generated studio
environment (works offline), a key light from nearly above, a floor fading into the background, the grid. One fixed
render quality for weak panel PCs: no shadows, `DPR` 1.

## Shared rules (`machine-facts.ts`)

The rules the scene, timeline, product history, metrics and inspector share: `faultText`, `productBeltX`, `isMissed`,
`zoneSides`, `zoneWarnings`, `onBelt`, `componentName`, machine messages and run state texts, `productMark`,
`tcpLimitBoxes` and `limitViolations` (each box prepared once with `orient`, then `orientedOverlap` in `frames.ts`: a
sphere test first, the separating axis test only for boxes that come close). `ROBOT_TCPS` says where a robot's TCPs lie.
