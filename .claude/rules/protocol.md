---
paths:
  - "packages/protocol/**"
---

# Protocol (`packages/protocol`)

The neutral data model shared by gateway and web: zod schemas plus their types, the Delta kinematics and the geometry
of XTS tracks (`xts-track.ts`). Every schema and field has a `.describe()` text; `/docs/schema.json` is generated
from them and a test fails for a field without one (ADR 0012). The `/health` report and the recording file lines are
schemas here too.

## Units and frames

All values are MCS: mm, degrees, Z up. A component's origin shift says where its coordinate system lies relative to
its pose; a conveyor's belt coordinates count from it, and a product's latch pose is in its conveyor's coordinate
system (pose + origin shift, X along the belt, ADR 0010), from which the belt travel moves it. Every zone has a CCS
offset (the robot's conveyor coordinate system on that belt).

## Component types

`COMPONENT_SCHEMAS` (`model.ts`) is the one list of component types: per type its config and state schema, its
`parameters` (the fields of its parameter set), its `hardware` (what a draft assumes) and its parameter set's
description. The compiler checks every key against its schemas' `type` and every listed field against its config.
The config and state unions, `PARAMETER_FIELDS`, `PARAMETER_SCHEMAS`, `TypedParametersSchema` and `HARDWARE_FIELDS`
follow from it. Adding a type: `.claude/docs/adding-a-component.md`.

What the PLC reports, by kind (the ADRs hold the reasons):

- A Delta reports only its TCP; the web derives the arms by inverse kinematics (ADR 0002).
- XTS gantries report their Z axis and per mover track position, X, C and gripper; XTS loops per mover the position
  along the loop. Both describe their track as a chain of 250 mm modules, straight or quarter curves, each with its own
  fault (ADR 0008).
- Cartesian robots report X, Y, Z and gripper; `axes` says which they have (`xz`: a fixed beam, `xy`: the flange at
  `zMin`).
- Deltas, XTS gantries and Cartesians may have a limit area (a box in the robot frame) and a TCP limit area (a box
  around the TCP, on an XTS gantry around every mover's flange).
- Every kinematics may have gripper fingers (cylinders) with absolute MCS poses; tool rotations exist only through
  them, and a picked product hangs at its `fingerId`. While a finger reports no pose (`poseReported` false) it sits at
  its offset on the flange (ADR 0018).
- Detectors and stations are drawn only from the bodies their FB describes (ADR 0007).
- Zones belong to robots, detectors and stations alike; a zone spans its belt or a lane of it (`startY` / `endY`).
- A product names its client, the component that changed it last, and its previous state (ADR 0009); it may carry a
  product mark 1 to 4, named per source in the config's `marks`.
- Every component, mover and track module may report a fault with a message.
- The machine entry (`MachineReport`, protocol 22, ADR 0021): run state, simulation mode, machine messages.

## Versions

`PROTOCOL_VERSION` changes with the Syn_Visu contract; the gateway still reads `MIN_PROTOCOL_VERSION`. The Syn_Config
contract has its own (`CONFIG_PROTOCOL_VERSION`, `MIN_CONFIG_PROTOCOL_VERSION`); recipes and their rules live in
`parameters.ts` (see the parameter-sets rule). Product registers travel as changes (`registers.ts`,
`RegisterEncoder` / `RegisterDecoder`, ADR 0013).
