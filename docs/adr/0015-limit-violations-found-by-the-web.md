# Limit violations are found by the web, not reported by the PLC

A robot may have a TCP limit area: a box around its TCP (on an XTS gantry around every mover's gripper flange), its
bounds relative to the TCP along the robot frame's axes. The PLC reports only the box, in the robot's config
(`stTcpLimitArea`, protocol version 19), and the TCP as before. The web app finds a limit violation itself: a TCP
limit area that overlaps another robot's limit area or another TCP limit area (also another mover's of the same
gantry), or that leaves its own robot's limit area. It lights up both boxes, lists the violation under every robot
involved, labels it above the TCP limit area and marks its start on the timeline of a recording.

It is the first thing the web app shows that the PLC did not report, so it is kept apart from faults: a violation is
listed with its own look (`ComponentFaults.limitViolations`, not `messages`), does not tint the robot red and is its
own kind of timeline event. One rule in `machine-facts.ts` (`limitViolations`) serves the 3D view, which checks the
interpolated positions it draws, and the timeline, which checks the reported ones. Robots of different sources are
never checked against each other: each source is drawn in its own space. A source that is offline is not checked,
because its last state says nothing about where its robots are now.

## Considered Options

- **The PLC checks and reports violations** (a flag or a fault per robot). Every machine project would have to
  program the same geometry, and the visualisation could only show what the PLC found; boxes of robots on different
  PLCs could not be checked at all without exchanging positions between them.
- **Check only axis-aligned hulls in the MCS.** Simpler, but a turned robot's limit area would count as overlapped
  where it is not; the check uses the separating axis test for boxes turned against each other.
- **Show a violation as a fault.** It would look like something the PLC reported and could not be told apart from a
  real fault in the component list or on the timeline.

## Consequences

- A violation is a warning on the screen, not a safety function: the PLC learns nothing of it, and the result
  depends on the positions the gateway read (at most one acquisition cycle late), the rule and the configured boxes.
- Boxes that only touch do not overlap; a TCP limit area on the edge of its own limit area is still inside.
- Recordings made before protocol 19 have no TCP limit areas and show no violations.
