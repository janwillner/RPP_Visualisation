import { type DeltaConfig, deltaForward, deltaInverse, type DeltaState, type Position } from "@rpp/protocol";
import {
  child,
  type Frame,
  frameFromPose,
  rotZ,
  toLocal,
  toMcs,
  toRenderer,
  toRendererTransform,
  type Vec3,
} from "../frames";
import { faultText } from "../../machine-facts";
import type { SceneDelta, SnapPoint } from "../scene-model";
import { carrierKey, type ComponentKit, LABEL_LIFT, lerpFingers, lerpPosition, lifted, MM, snapOwner } from "./kit";

/** A Delta robot: its arms from its TCP (inverse kinematics), working area, limit area, gripper and zones. */
export const deltaKit: ComponentKit<"delta"> = {
  originRank: 1,
  build(c, state, ctx) {
    const frame = frameFromPose(c.pose);
    const delta = buildDelta(c, state);
    ctx.scene.deltas.push(delta);
    ctx.addFault(c.id, null, delta.fault, lifted(frame.origin, LABEL_LIFT.delta));
    if (state) {
      // The flange frame lies at the TCP with the MCS axes, whatever way the robot is mounted.
      const flange: Frame = { rotation: rotZ(0), origin: positionToMcs(state.actualTcp) };
      ctx.carriers.set(carrierKey(c.id, 0), flange);
      ctx.addGripper(c, [{ moverId: 0, flange, states: state.fingers, faulted: delta.fault !== null }]);
    }
    ctx.scene.snapPoints.push(...deltaSnapPoints(c, state));
    const w = c.workingArea;
    ctx.scene.workingAreas.push({
      robotId: c.id,
      transform: toRendererTransform(frame),
      radius: w.radius * MM,
      zMin: w.zMin * MM,
      zMax: w.zMax * MM,
      coneHeight: w.coneHeight * MM,
      coneBottomRadius: w.coneBottomRadius * MM,
    });
    ctx.addLimitArea(c);
    ctx.addZones(c);
  },
  interpolate: (a, b, f) => ({
    ...a,
    actualTcp: lerpPosition(a.actualTcp, b.actualTcp, f),
    setpointTcp: lerpPosition(a.setpointTcp, b.setpointTcp, f),
    fingers: lerpFingers(a.fingers, b.fingers, f),
  }),
};

/**
 * The PLC reports only the TCP (effector centre); the arms follow it by inverse kinematics in the robot frame.
 * Before the first state the robot is drawn with horizontal upper arms.
 */
function buildDelta(c: DeltaConfig, state: DeltaState | undefined): SceneDelta {
  const frame = frameFromPose(c.pose);
  const world = (local: Vec3) => toRenderer(toMcs(frame, local));
  const localTcp = state ? toLocal(frame, positionToMcs(state.actualTcp)) : undefined;
  const angles = localTcp ? deltaInverse(c, localTcp) : [0, 0, 0];
  const posture = deltaForward(c, (angles ?? [0, 0, 0]) as [number, number, number]);
  const effectorCentre = localTcp ?? posture.effector;
  return {
    id: c.id,
    name: c.name,
    base: toRendererTransform(frame),
    baseRadius: c.baseRadius * MM,
    effectorRadius: c.effectorRadius * MM,
    shoulders: posture.shoulders.map(world),
    elbows: angles ? posture.elbows.map(world) : [],
    effectorJoints: angles ? posture.effectorJoints.map(world) : [],
    effector: effectorCentre ? toRendererTransform(child(frame, effectorCentre)) : null,
    reachable: angles !== null,
    actualTcp: state ? toRenderer(positionToMcs(state.actualTcp)) : null,
    setpointTcp: state ? toRenderer(positionToMcs(state.setpointTcp)) : null,
    angles: angles ?? [],
    fault: faultText(state?.fault),
  };
}

/** Base, shoulders, working area and actual TCP of a Delta, in its base frame. */
function deltaSnapPoints(c: DeltaConfig, state: DeltaState | undefined): SnapPoint[] {
  const owner = snapOwner(c, frameFromPose(c.pose));
  // The shoulders do not depend on the arm angles.
  const { shoulders } = deltaForward(c, [0, 0, 0]);
  const w = c.workingArea;
  const points = [
    owner.at(`${c.name} · base`, [0, 0, 0]),
    ...shoulders.map((s, i) => owner.at(`${c.name} · shoulder ${i + 1}`, s)),
    owner.at(`${c.name} working area · top`, [0, 0, w.zMax], "workingAreas"),
    owner.at(`${c.name} working area · bottom`, [0, 0, w.zMin], "workingAreas"),
  ];
  if (w.coneHeight > 0) {
    points.push(owner.at(`${c.name} working area · cone bottom`, [0, 0, w.zMin - w.coneHeight], "workingAreas"));
  }
  if (state) points.push(owner.atMcs(`${c.name} · TCP`, positionToMcs(state.actualTcp), "structure", true));
  return points;
}

function positionToMcs(p: Position): Vec3 {
  return [p.x, p.y, p.z];
}
