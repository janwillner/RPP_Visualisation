# Packaging machine visualisation

A read-only 3D view of a packaging machine, built from what the PLC reports. It is used to set up and debug conveyor tracking and robots.

## Machine and coordinates

**MCS (machine coordinate system)**:
The single coordinate system of a machine, in mm and degrees: right-handed, Z up, X in the product flow direction. Every position the PLC reports is given in it.
_Avoid_: world coordinates, global frame

**Pose**:
Position and orientation of something in the MCS.
_Avoid_: location, placement

**Component**:
One visualised part of a machine that the PLC registers: a conveyor, a Delta robot, an XTS gantry, an XTS loop, a Cartesian robot, a vision system, a product sensor or a station.
_Avoid_: unit, device, module

**Recording**:
What the visualisation received from the gateway during a period, kept to be played back: every source with its configuration, faults and state.
_Avoid_: log, trace, history

**Playback**:
Showing a recording in the 3D view instead of the live machine, at any speed or moment.
_Avoid_: replay (except for the replay buffer and replaying its last minute), simulation (the simulator is something else)

**Replay buffer**:
What the visualisation always keeps of the last minute it received, from the page's start; one button turns it into a recording.
_Avoid_: ring buffer, instant replay, last-minute recording

**Timeline event**:
A moment of a recording worth finding again, marked on its timeline: a fault appears, a source goes offline or comes back, a product is missed.
_Avoid_: alarm, bookmark

**Product history**:
What happened to one product while the visualisation watched it: when it entered its conveyor's register, was assigned, picked, placed, released or rejected and by which client, missed, and when it left the register.
_Avoid_: product trace, tracking log

**Metrics**:
Figures of the last minute counted from what happened to the products: what each client did per minute (detected, picked, placed, rejected), products entering each conveyor per minute, missed and rejected products, and the share of missed products.
_Avoid_: KPIs, OEE (the visualisation does not know the machine's availability or quality)

**Source**:
One PLC runtime the visualisation reads, identified by its AmsNetId and ADS port. A machine may span several sources; all of them report in the same MCS, and component ids are unique only within one source.
_Avoid_: connection, target, IPC (an IPC may run several sources)

**Manifest**:
The PLC's list of the components it currently has, each with an id, a type, a display name and where its data lives.
_Avoid_: descriptor, registry

**Origin shift**:
Where a component's coordinate system lies relative to its pose. A conveyor's belt coordinates count from it.
_Avoid_: offset, zero point

**Configuration** (of a component):
The rarely changing description of a component, such as its pose, dimensions, geometry, working area and zones.
_Avoid_: settings, parameters

**State** (of a component):
The values of a component that change every PLC cycle, such as the belt position, product register and TCP.

**PLC library guide**:
What the gateway serves at `/docs` for PLC programmers: how to use the library `Syn_Visu` of the version it runs, with diagrams and the reference of every method. Programs that read the gateway get the JSON Schema of its messages at `/docs/schema.json`.
_Avoid_: API documentation, API spec, Swagger

## Conveyors and products

**Conveyor**:
A belt or chain that moves products along its local X axis (the conveying direction). A conveyor without a body has no belt of its own to draw (e.g. products pushed along by movers); it is shown only by its products, zones and axis.
_Avoid_: band, belt (when meaning the whole component)

**Belt position**:
How far the conveyor's surface has travelled, in mm, counting continuously without wrapping.
_Avoid_: encoder value (when meaning the position itself)

**Product register**:
The PLC's list of products currently tracked on a conveyor.
_Avoid_: data register, product buffer

**Register form**:
A state in which each conveyor lists only the products that changed since the previous state of its source, plus the ids of its whole product register in order (ADR 0013). Recordings store states in register form; the web app receives them so.
_Avoid_: delta, diff state

**Client**:
A component that works on the products of a conveyor: a robot, a detector or a station. Every product names the client that changed it last and the state it had before.
_Avoid_: consumer, handler

**Product type**:
The size and shape a conveyor's products can have: a box, a cylinder (round, or oval when its two diameters differ) or a rounded box (a box with rounded vertical edges, such as a pouch or flow pack). Every product in a register refers to one.
_Avoid_: format, article

**Latch**:
The moment a product is detected on a conveyor, by the client that latched it (a detector or a station) if one is named. Its pose on the belt (in the conveyor's belt coordinates, from where they count) and the belt position at that moment are stored; the product's current position is the latch pose moved by the belt travel since.
_Avoid_: trigger, capture

**Placeholder**:
The outline left travelling on the conveyor where a picked product used to lie, while the robot holds it. A product put down on a conveyor is drawn there as itself, not as a placeholder.
_Avoid_: ghost, empty product

**Missed product**:
A product that reached the end of its conveyor without being picked. Products placed onto a conveyor (an outfeed) or rejected pass its end on purpose and are not missed.
_Avoid_: lost product

**Product mark**:
One of four marks (1 to 4) the PLC can give a product to single it out, e.g. a sample; the PLC names each mark once for the whole source. A marked product is drawn in its mark's colour instead of its state colour while the layer "Product marks" is on; only the selection colour wins over it. The mark stays with the product through state changes and moves between conveyors.
_Avoid_: product colour, highlight, flag

**Fault**:
A condition the PLC reports for a component, a single mover or a single track module, with a message for the operator, until it clears it. A faulted component, mover or track module is drawn red.
_Avoid_: error (for the display), alarm, warning

## Robots

**Delta robot**:
A parallel-kinematics robot with three arms carrying an effector below a fixed base.
_Avoid_: delta, picker (when meaning the robot)

**TCP (tool centre point)**:
The effector centre of a robot in the MCS. The **actual TCP** is where the robot is; the **setpoint TCP** is where it is commanded to be.
_Avoid_: tool position, end point

**XTS gantry**:
A straight track of XTS linear motor modules on a common Z axis; every mover carries its own X axis with a gripper that rotates about C. Example: IDH.
_Avoid_: IDH (when meaning the kinematics), linear XTS

**XTS loop**:
A closed XTS track, usually two straights joined at each end by two curve modules, on which movers circulate, take products over, change their spacing and hand them on. Example: Fxx.
_Avoid_: Fxx (when meaning the kinematics), oval, carousel

**Cartesian robot**:
A robot with linear X, Y and Z axes on two fixed rails and a gripper head that turns about C and tilts about A. It may lack the Y axis (X-Z: a fixed beam instead of rails and bridge) or the Z axis (X-Y: a column of fixed length); its **axes** say which.
_Avoid_: portal, gantry (that is always the XTS gantry), linear robot

**Bridge**:
The beam of a Cartesian robot that spans its rails and travels along them in Y.
_Avoid_: portal beam, crossbar

**Beam**:
The fixed beam along X of a Cartesian robot without a Y axis; the carriage travels on it.
_Avoid_: bridge (that travels), rail

**Carriage**:
The slide of a Cartesian robot that travels along the bridge in X and carries the column.
_Avoid_: trolley, slide

**Column**:
The vertical Z axis of a Cartesian robot; the gripper head sits at its lower end.
_Avoid_: quill, Z arm

**Gripper head**:
The end of a Cartesian robot's column that turns about C and tilts about A, carrying the gripper.
_Avoid_: wrist, tool head

**Gripper**:
The tool at a robot's flange (or a mover's) that holds products, made of one or more fingers.
_Avoid_: tool head, end effector

**Gripper flange**:
The point where a gripper is mounted: a Delta's TCP, the end of an XTS gantry mover's X arm, an XTS loop mover's tool point or the lower end of a Cartesian robot's column.
_Avoid_: tool mount, wrist

**Finger**:
One element of a gripper that grips a product, e.g. a suction cup or a jaw.
_Avoid_: cup (a cup is one kind of finger), jaw (likewise), gripper element

**Finger offset**:
Where a finger sits on its gripper flange: its position in the flange frame and its rotation about the flange's Z. The visualisation places a finger by it while the application reports no pose for the finger; the configurator lays the offsets out in a top view of the flange (ADR 0018).
_Avoid_: finger position (ambiguous with its live pose), tool offset (the distance of an XTS flange from its mover)

**Grip point**:
The point at the end of a finger where a carried product's top touches.
_Avoid_: TCP (the TCP is the flange of a Delta)

**Mover**:
A carriage driven along an XTS track.
_Avoid_: shuttle, slider

**Track**:
The path movers run along on an XTS gantry or an XTS loop: a chain of track modules, joined end to start. An XTS loop's track closes on itself.
_Avoid_: rail, guide

**Track module**:
One XTS motor module, 250 mm long along the track: a straight module or a curve module. Each can report its own fault.
_Avoid_: segment, motor (when meaning the module)

**Curve module**:
A track module that turns the track by a quarter circle (90°) to the left or right. Two in a row make the half turn at the end of an XTS loop.
_Avoid_: bend, arc module

**Track position**:
How far along its track a mover is, in mm, from the start of the first track module.
_Avoid_: mover encoder

**Working area**:
The volume the PLC allows a robot to move in.
_Avoid_: work area, workspace, reach (reach is what the kinematics allow)

**Limit area**:
A box around a Delta robot, an XTS gantry or a Cartesian robot that further restricts its working area, so that neighbouring robots cannot collide. An XTS loop has none.
_Avoid_: collision zone, safety box, limit zone

**TCP limit area**:
A box around a robot's TCP (on an XTS gantry around every mover's gripper flange), its bounds relative to the TCP along the robot frame's axes: what the gripper and the product it carries take up. It moves with the TCP and never turns.
_Avoid_: TCP box, tool box, collision box

**Limit violation**:
A TCP limit area that overlaps another robot's limit area or another TCP limit area, or leaves its own robot's limit area. The visualisation finds it from the reported positions and shows it; the PLC does not report it, and it is not a fault.
_Avoid_: collision, limit fault, limit error

**Zone**:
A stretch of a conveyor, measured along the conveying direction, that belongs to a component: where a robot may pick or place products, where a detector detects them. A zone of length 0 is a line across the belt.
_Avoid_: window, tracking window

**Pick zone** / **Place zone**:
A robot's zone in which it picks products from a conveyor or places them onto it. The visualisation does not tell them apart.
_Avoid_: window, tracking window

**Allocation area**:
The part of a zone, from its start up to the allocation limit, in which a robot may still allocate products.
_Avoid_: reservation zone, booking area

**Allocation limit**:
The point in a zone, a set distance before its end, beyond which a robot no longer allocates products, so that it does not leave the zone while approaching one.
_Avoid_: allocation end, reservation limit

**CCS (conveyor coordinate system)**:
Where a component's coordinate system for one conveyor lies along that conveyor, given per zone as a belt coordinate.
_Avoid_: client position, tracking origin

## Detectors and stations

**Detector**:
A component that detects products on a conveyor in its zones: a vision system or a product sensor. The PLC latches what it detects.
_Avoid_: scanner, trigger

**Vision system**:
A camera over a conveyor that detects products in its field of view.
_Avoid_: camera (when meaning the whole component), scanner

**Product sensor**:
A sensor at a conveyor that detects products at one point, e.g. a light barrier whose beam a product interrupts.
_Avoid_: initiator, photo-eye

**Station**:
A client at a conveyor that works on the products in its zones without kinematics of its own, e.g. a reject unit, a labeller, a printer or a check weigher. It is drawn from the bodies the PLC describes.
_Avoid_: generic component, unit, device

**Body**:
One solid a component is drawn from as its PLC describes it: a box, a cylinder or a frustum with a role (a machine part, a sensing part, a beam, a field of view). A conveyor's body is its belt, drawn from its length and width, not described by the PLC; the PLC only says whether it has one (see Conveyor).
_Avoid_: shape (a product type has a shape), part

## Configurator

**Configurator**:
The second web app (`/configurator`, `apps/configurator`): the machine's components are placed in 3D and given their configuration, to be written to the PLC later. The visualisation's counterpart.
_Avoid_: editor, designer, RPP_Configurator (the product name, not a term)

**Machine view**:
What the visualisation and the configurator share (`@rpp/machine-view`, ADR 0019): the gateway connection with its sources, the machine scene and its 3D view, the rules about the machine both apply, and the shared look. Neither app's own parts are in it.
_Avoid_: shared code, common library

**Draft**:
A machine as the configurator edits it: every component's configuration with its source and manifest id, saved as a JSON file. It is made offline, without a PLC.
_Avoid_: project, layout, model, recipe

**Reconciliation**:
Matching a draft's components with the PLCs' manifests by source, manifest id and type, telling which the PLC has as the draft does, which differ, and which exist on one side only.
_Avoid_: sync, diff, comparison

**Ghost**:
The PLC's version of a component the draft has changed, drawn faded beside the draft's, so the change shows in 3D.
_Avoid_: shadow, preview, overlay

**Parameter set**:
The part of a component's configuration its application runs with and the configurator writes (pose, zones, product types, an XTS track's modules, areas; never hardware), held by its parameter FB of the library Syn_Config.
_Avoid_: recipe, settings, parameters (alone)

**Staging**:
Writing a parameter set into a component's parameter FB, where it waits until the application allows taking it over.
_Avoid_: upload, download, commit

**Program values**:
The configuration an application gives in its code, which applies while no parameter set is active.
_Avoid_: defaults (in prose), factory settings

**Palette**:
The component types the configurator offers to place, by dragging onto the floor or by a click.
_Avoid_: toolbox, library (the PLC library is something else)
