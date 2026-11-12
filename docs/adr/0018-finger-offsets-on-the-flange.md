# Fingers have an offset on the flange; the web places those whose pose is not reported

A gripper's fingers were defined only by their size (protocol 7): the application reported every finger's pose
absolute in the MCS each cycle. To do that it had to program the gripper's geometry itself: where each finger sits on
the flange, turned with the robot, along the XTS track's curves. The configurator (ADR 0016) lays a gripper out in a
top view of the flange and writes it with the parameter set (ADR 0017), so the layout needs a place in the
configuration.

So every finger has an **offset** on the gripper flange (`offset` / `stOffset`: position in the flange frame and
rotation about its Z; protocol version 20), and every finger state says whether the application reported its pose
(`poseReported` / `bPoseReported`). While it did not, **the web** places the finger by its offset on the flange frame
it already computes for every kinematics: a Delta's at the TCP with the robot's axes (the gripper is bolted to the
effector, which stays turned with the base; a product carried at the flange itself still hangs along the MCS axes), a
Cartesian robot's with the robot's axes, an XTS mover's turned with the mover (also around the loop's curves). In
every one of them the flange frame's −Z points to the product.

- **Syn_Visu** stores the offset (`_FB_VisuRobot.m_SetFingerOffset`; `m_SetFinger` keeps it) and sets
  `bPoseReported`: `m_SetFingerState` of a Delta or a Cartesian robot marks its finger as reported, so an application
  that never calls it gets its fingers placed by their offsets without a change; an XTS track's `m_SetMover` marks
  every finger as reported, unless the application declared `m_SetFingersOnFlange(TRUE)`. A finger once reported stays
  reported until the PLC restarts: an application reports its poses or it does not. Every existing call stays as it is
  (TwinCAT 4024 needs every input of a method call, so no input was added).
- **The configurator** opens a draft saved before protocol 20 with its fingers on the flange centre, and draws a draft
  robot with fingers at rest (`rest-states.ts`: a Delta's TCP in the middle of its working area, a Cartesian robot in
  the middle of its strokes, one mover per XTS track), its finger states empty, so the scene places every finger by its
  offset.
- **Syn_Config 2.0.0** holds the fingers with their offsets in the robots' parameter sets (config protocol 2) and
  passes them on with `m_SetFinger` and `m_SetFingerOffset`.

## Considered Options

- **Syn_Visu computes the poses** (as the ticket first said). Every robot FB would need the flange in the MCS: the
  robot pose's rotation for the Cartesian robot, the mover position along the module chain with its curves for XTS.
  The geometry would exist twice, in ST and in the web, and had to agree; the poses would be available to the PLC
  logic, which does not need them. Chosen against by the user.
- **A finger pose of all zeros means "not reported".** No contract change for the state, but a finger may well sit at
  the MCS origin, and the rule would be hidden.
- **New inputs on `m_SetFinger` and `m_SetMover`.** Shorter, but every existing call would stop compiling.

## Consequences

- A tool rotation (a Delta's 4th axis, an IDH's C) does not show on fingers placed by their offsets; an application
  that has one reports the poses as before.
- Protocol 20 needs Syn_Visu 9.5 and a gateway of protocol 20 together; Syn_Config 2.0 and the gateway's
  `CONFIG_PROTOCOL_VERSION` 2 too.
- The demo's Fxx loop reports no finger poses any more (its own flange computation is gone); its Deltas lay their
  fingers out as program values (Delta 1 through its parameter set) and still report the live poses.
