# XTS tracks are chains of motor modules, curves drawn as circular arcs

Until protocol 11 the visualisation knew two fixed track shapes: an XTS gantry was `moduleCount` equal modules in a row, an XTS loop two straights joined by two semicircles of a free radius. Real XTS tracks are built from Beckhoff motor modules that are always 250 mm long: straight modules and curve modules that turn by a quarter circle. A loop's end is two quarter curves, not a semicircle of any radius, and the operator wants to see each module, because a module can fail on its own (overtemperature, a motor fault).

So the PLC now reports a track as a chain of modules in the order the movers run along it: each module is straight or a quarter curve to the left or right, with its length along the track. The library holds the XTS facts (`VISU_lr_XTS_MODULE_LENGTH` = 250 mm, the quarter curve); the visualisation only lays the modules end to start, and the same geometry (`packages/protocol/src/xts-track.ts`) serves the web scene and the simulator. Gantry and loop share it; a gantry's track simply has no curves. Every module has a live state with its fault, drawn red on that module.

A curve module is drawn as a circular quarter arc as long as the module (radius 2 · 250 / π ≈ 159.2 mm). Beckhoff's curves are clothoids, so the drawn shape differs from the real one by a few millimetres, but a mover's track position stays exact along the track, which is what matters for products and movers.

## Considered Options

- **Keep the fixed shapes and add a module count to the loop.** No change to the PLC contract, but no per-module faults and still a semicircle of a free radius that does not match the modules.
- **The visualisation knows the XTS module catalogue (part numbers, clothoid geometry).** Exact curves, but the web would have to know XTS hardware, against the rule that it knows as little as possible about what a component is.
- **The PLC reports each module's pose.** Fully general, but moves geometry into every application and duplicates what follows from the chain.

## Consequences

- Breaking: protocol 12, library 5.0.0. Applications replace `m_Configure`'s track parameters with one `m_SetModule` per module (`docs/plc-contract.md`).
- A loop whose chain does not close is still drawn, with a configuration warning.
- Recordings made before protocol 12 still play: their XTS components are drawn without a track (their configs have no modules), the movers where their positions lie, without module faults.
