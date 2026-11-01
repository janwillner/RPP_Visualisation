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
_Avoid_: replay, simulation (the simulator is something else)

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

## Conveyors and products

**Conveyor**:
A belt or chain that moves products along its local X axis (the conveying direction).
_Avoid_: band, belt (when meaning the whole component)

**Belt position**:
How far the conveyor's surface has travelled, in mm, counting continuously without wrapping.
_Avoid_: encoder value (when meaning the position itself)

**Product register**:
The PLC's list of products currently tracked on a conveyor.
_Avoid_: data register, product buffer

**Client**:
A component that works on the products of a conveyor: a robot, a detector or a station. Every product names the client that changed it last and the state it had before.
_Avoid_: consumer, handler

**Product type**:
The size and shape a conveyor's products can have: a box, a cylinder (round, or oval when its two diameters differ) or a rounded box (a box with rounded vertical edges, such as a pouch or flow pack). Every product in a register refers to one.
_Avoid_: format, article

**Latch**:
The moment a product is detected on a conveyor, by the client that latched it (a detector or a station) if one is named. Its pose and the belt position at that moment are stored; the product's current position is the latch pose moved by the belt travel since.
_Avoid_: trigger, capture

**Placeholder**:
The outline left travelling on the conveyor where a picked product used to lie, while the robot holds it. A product put down on a conveyor is drawn there as itself, not as a placeholder.
_Avoid_: ghost, empty product

**Missed product**:
A product that reached the end of its conveyor without being picked. Products placed onto a conveyor (an outfeed) or rejected pass its end on purpose and are not missed.
_Avoid_: lost product

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
A robot with linear X, Y and Z axes on two fixed rails and a gripper head that turns about C and tilts about A.
_Avoid_: portal, gantry (that is always the XTS gantry), linear robot

**Bridge**:
The beam of a Cartesian robot that spans its rails and travels along them in Y.
_Avoid_: portal beam, crossbar

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
A box around a Delta robot that further restricts its working area, so that neighbouring robots cannot collide.
_Avoid_: collision zone, safety box, limit zone

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
One solid a component is drawn from as its PLC describes it: a box, a cylinder or a frustum with a role (a machine part, a sensing part, a beam, a field of view).
_Avoid_: shape (a product type has a shape), part
