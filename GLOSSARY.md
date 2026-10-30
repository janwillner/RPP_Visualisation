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
One visualised part of a machine that the PLC registers: a conveyor, a Delta robot, an XTS gantry, an XTS loop or a Cartesian robot.
_Avoid_: unit, device, module

**Manifest**:
The PLC's list of the components it currently has, each with an id, a type, a display name and where its data lives.
_Avoid_: descriptor, registry

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

**Latch**:
The moment a product is detected on a conveyor. Its pose and the belt position at that moment are stored; the product's current position is the latch pose moved by the belt travel since.
_Avoid_: trigger, capture

**Placeholder**:
The outline left travelling on the conveyor where a picked product used to lie.
_Avoid_: ghost, empty product

**Missed product**:
A product that reached the end of its conveyor without being picked.
_Avoid_: lost product

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
A closed XTS track of two straights joined by two curves on which movers circulate, take products over, change their spacing and hand them on. Example: Fxx.
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

**Track module**:
One XTS motor module; an XTS gantry's track is a row of equal modules.
_Avoid_: segment, motor (when meaning the module)

**Track position**:
How far along its track a mover is, in mm: from the track start on an XTS gantry, from the start of the lower straight in the conveying direction on an XTS loop.
_Avoid_: mover encoder

**Working area**:
The volume the PLC allows a robot to move in.
_Avoid_: work area, workspace, reach (reach is what the kinematics allow)

**Limit area**:
A box around a Delta robot that further restricts its working area, so that neighbouring robots cannot collide.
_Avoid_: collision zone, safety box, limit zone

**Pick zone** / **Place zone**:
The stretch of a conveyor, measured along the conveying direction, where a robot may pick products from it or place products onto it.
_Avoid_: window, tracking window

**Allocation area**:
The part of a zone, from its start up to the allocation limit, in which a robot may still allocate products.
_Avoid_: reservation zone, booking area

**Allocation limit**:
The point in a zone, a set distance before its end, beyond which a robot no longer allocates products, so that it does not leave the zone while approaching one.
_Avoid_: allocation end, reservation limit
