# Product poses in the conveyor's coordinate system

Until protocol 13 a product's latch pose (`stLatchPose`) was absolute in the MCS, like the finger poses and the Delta's TCP. The PLC applications, however, know where a product lies on its belt: a vision system or a sensor reports it relative to the conveyor, and the zones and CCS of the robots are belt coordinates already. Every application had to turn these into the MCS before latching, and back when it read the register.

From protocol 14 the latch pose is given in the conveyor's coordinate system: from the conveyor's pose moved by its origin shift, X along the belt, Y across it, Z up from the belt surface, Rz from the belt's X. The belt travel since the latch still moves the product along that X (`fBeltPosition − fLatchBeltPosition`). `m_GetProduct` and `m_MoveProduct` of `_FB_VisuConveyor` use the same coordinates. The web app places the product in the MCS from the conveyor's config. Robots keep working in the MCS (finger poses, TCP); where one puts a product down, the application converts the finger's position into the target conveyor's coordinates. The library offers no conversion method on purpose: the applications already have the belt values, and the demo does its own conversion (`_FC_DemoMcsToBelt`, `_FC_DemoBeltToMcs`).

## Considered Options

- **Keep the MCS latch pose.** No break, but the conversion stays in every application, and a conveyor moved in the MCS (a new pose in `m_Configure`) would move its products' positions in every application too.
- **Belt coordinates from the conveyor's pose, not its origin shift.** One coordinate system fewer, but zones and CCS already count from the origin shift; products would count from a different point than everything else on the belt.
- **A conversion method in the library (`m_McsToConveyor`).** Convenient for placing robots, but not needed by the applications at hand; it can still be added without a protocol change.

## Consequences

- Protocol 14 and library 7.0.0 break every application: every `vi_LatchPose` and `m_MoveProduct` pose, and every pose read with `m_GetProduct`, changes its frame. Recordings of protocol 13 cannot be played back.
- A product's latch pose no longer changes when the conveyor's pose does; moving a conveyor in the config moves its products with it.
