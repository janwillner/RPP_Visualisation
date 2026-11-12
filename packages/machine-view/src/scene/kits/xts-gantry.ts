import { trackLength, trackPoints, type XtsGantryConfig, type XtsGantryState } from "@rpp/protocol";
import {
  child,
  type Frame,
  frameFromPose,
  mul,
  rotZ,
  toMcs,
  toRenderer,
  toRendererTransform,
  type Vec3,
} from "../frames";
import { faultText, gantryFlange } from "../../machine-facts";
import type { SceneBoxArea, SceneGantry, SceneGantryMover } from "../scene-model";
import { carrierKey, type ComponentKit, LABEL_LIFT, lerp, lerpFingers, MM, snapOwner, withModules } from "./kit";
import { layTrack, MoverParts, TRACK_PLANE } from "./xts-track";

/** An XTS gantry: its track, the movers on it with their flanges, its reachable volume, limit area, grippers and zones. */
export const xtsGantryKit: ComponentKit<"xtsGantry"> = {
  build(c, state, ctx) {
    const built = buildGantry(withModules(c), state);
    ctx.scene.gantries.push(built.gantry);
    ctx.scene.boxAreas.push(built.area);
    ctx.scene.snapPoints.push(...built.snapPoints);
    for (const [moverId, frame] of built.carriers) ctx.carriers.set(carrierKey(c.id, moverId), frame);
    for (const f of built.faults) ctx.addFault(c.id, f.part, f.message, f.anchor);
    ctx.addGripper(c, built.grippers);
    ctx.addLimitArea(c);
    ctx.addZones(c);
  },
  interpolate(a, b, f) {
    const next = new Map(b.movers.map((m) => [m.id, m]));
    return {
      ...a,
      z: lerp(a.z, b.z, f),
      movers: a.movers.map((m) => {
        const n = next.get(m.id);
        return n
          ? { ...m, position: lerp(m.position, n.position, f), x: lerp(m.x, n.x, f), fingers: lerpFingers(m.fingers, n.fingers, f) }
          : m;
      }),
    };
  },
};

/** Mover frames of an XTS gantry, its track, its reachable volume, snap points and the frames products hang from. */
function buildGantry(c: XtsGantryConfig, state: XtsGantryState | undefined) {
  const frame = frameFromPose(c.pose);
  const z = state?.z ?? 0;
  const length = trackLength(c.modules);
  const group = child(frame, [0, 0, z]);
  // The beam above the movers: as wide as a mover plus 20 mm each side, 120 mm high.
  const half = (c.moverWidth + 40) / 2;
  // Recordings made before protocol 12 have no module states.
  const track = layTrack(c, state?.modules ?? [], TRACK_PLANE.xtsGantry, group, false, {
    across: [-half, half],
    depth: [0, 120],
  });
  const owner = snapOwner(c, frame);
  const gantryFault = faultText(state?.fault);
  const parts = new MoverParts(c.name, owner, gantryFault, track.top);
  parts.snapPoints.push(...track.boundaries.map((b) => owner.atMcs(b.label, b.mcs, "structure", true)));
  const pointAt = trackPoints(c.modules, false);
  const movers = (state?.movers ?? []).map((m): SceneGantryMover => {
    // Mover frame: +X its X axis (to the right of the track), +Y along the track, +Z up.
    const at = track.at(m.position);
    const mover = child(group, at.origin, mul(at.rotation, rotZ(-90)));
    const toolX = m.x + c.toolOffsetX;
    // The flange where the TCP limit area is checked, turned with the mover.
    const tip: Frame = { rotation: mover.rotation, origin: toMcs(frame, gantryFlange(c, pointAt, z, m)) };
    const fault = parts.add(m, mover, tip, LABEL_LIFT.gantryMover, "flange");
    return {
      id: m.id,
      carriage: toRenderer(mover.origin),
      armEnd: toRenderer(toMcs(mover, [toolX, 0, 0])),
      tip: toRendererTransform(tip),
      gripperActive: c.fingers.length === 0 && m.gripperActive,
      fault,
    };
  });
  const centre: Vec3 = [(c.xMin + c.xMax) / 2 + c.toolOffsetX, length / 2, (c.zMin + c.zMax) / 2 + c.toolOffsetZ];
  return {
    gantry: {
      id: c.id,
      name: c.name,
      track: toRendererTransform(group),
      modules: track.modules,
      moverLength: c.moverLength * MM,
      moverWidth: c.moverWidth * MM,
      movers,
      fault: gantryFault,
    } satisfies SceneGantry,
    area: {
      robotId: c.id,
      transform: toRendererTransform(child(frame, centre)),
      size: [(c.xMax - c.xMin) * MM, length * MM, (c.zMax - c.zMin) * MM],
    } satisfies SceneBoxArea,
    snapPoints: parts.snapPoints,
    carriers: parts.carriers,
    grippers: parts.grippers,
    faults: [...parts.faults, ...track.faults],
  };
}
