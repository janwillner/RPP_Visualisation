# Simple components are drawn from bodies the PLC describes

Until protocol 10 every component type had its own code in every layer: PLC structures, a gateway mapper, a scene builder and a mesh. Adding the Cartesian robot touched 32 files. For the vision system and the product sensor, and for the parts that will follow (printers, scales, reject gates), that is a lot of code for something the visualisation only has to show: where the part is, which stretch of a conveyor it works on, and whether it is faulted.

These components therefore describe themselves. Their contract structure (`ST_VisuDetector`) holds zones and up to 16 bodies: a box, a cylinder or a frustum, each with a pose in the component's frame, its size and a role (structure, sensor, beam, field of view) that sets its look. The library's function blocks describe the bodies in `m_Configure`, so the application calls only that. The web app draws bodies, zones and faults without knowing what the component is; the manifest type is only a label in the component tree. A new simple component needs a library function block and one line per layer, no drawing code.

Components with real logic keep their own code: the Delta's arms follow its TCP by inverse kinematics, movers run along a track, a conveyor carries a product register. They are not described as bodies, because the visualisation computes their look from a few reported values.

The same release made the gateway's mapping generic: it walks the protocol's zod schema and finds each field's PLC member by the naming convention of the contract structures (`docs/plc-contract.md`). A structure that keeps the convention needs no mapping code.

## Considered Options

- **Own drawing code per component, as for the robots.** Exact looks (a real camera model), but a web release for every new part, and the looks are not what the visualisation is for.
- **A generic component for everything, the robots included.** The PLC would report every part's pose each cycle. That moves kinematics into every application and multiplies the data read per cycle; the robots stay as they are.

## Consequences

- A detector looks only as good as its bodies. The library's `m_Configure` gives a sensible default; an application can add bodies (`m_SetBody`), e.g. a bracket.
- Overlay bodies (beam, field of view) are not clickable, so they do not cover the products inside them; a detector is selected through its machine parts or the component tree.
- The contract structures must keep the naming convention strictly; a member that does not is reported as a discovery error for that component.
- Protocol 13 added the station (ADR 0009), drawn from bodies too, with its own structure `ST_VisuStation`; the body
  handling moved from `_FB_VisuDetector` to the shared base `_FB_VisuBodyComponent`, and machine parts (not only
  overlays) light up while active.
