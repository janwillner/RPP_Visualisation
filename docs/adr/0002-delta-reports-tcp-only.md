# A Delta reports only its TCP; the visualisation derives the arms

Since protocol version 2, the PLC reports only a Delta robot's actual and setpoint TCP, plus its geometry in the configuration. The visualisation computes the arm posture from the TCP by inverse kinematics. Version 1 transmitted the axis angles together with a per-axis offset and direction. That made every PLC project map its drive positions onto our angle convention, and the visualisation was only correct if that calibration was right. Sending the TCP keeps the PLC side trivial, because the TCP is already known in every pick-and-place program, and it makes the effector always appear exactly where the PLC thinks it is.

## Consequences

- We gave up a debugging aid: drawing the arms from the axis angles and comparing the resulting effector with the reported TCP used to expose calibration and geometry errors. The setpoint TCP marker, which shows following error, remains.
- A TCP the configured geometry cannot reach is shown with the effector at the TCP and the arms hidden, flagged as unreachable.
- The effector rotation (4th axis) comes from the TCP's `rz`.
