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
One visualised part of a machine that the PLC registers: a conveyor, a Delta robot, an XTS gantry or an XTS loop.
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

**Pick zone** / **Place zone**:
The stretch of a conveyor, measured along the conveying direction, where a robot may pick products from it or place products onto it.
_Avoid_: window, tracking window
