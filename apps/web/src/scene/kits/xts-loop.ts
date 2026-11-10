import { trackLength, type XtsLoopConfig, type XtsLoopState } from "@rpp/protocol";
import { child, frameFromPose, mul, rotX, toRenderer, toRendererTransform } from "../frames";
import { faultText } from "../../machine-facts";
import type { SceneLoop, SceneLoopMover } from "../scene-model";
import { carrierKey, type ComponentKit, LABEL_LIFT, lerpFingers, lerpWrapped, MM, snapOwner, withModules } from "./kit";
import { layTrack, MoverParts, TRACK_PLANE } from "./xts-track";

/** An XTS loop: its closed track and the movers along it with their grippers and zones. */
export const xtsLoopKit: ComponentKit<"xtsLoop"> = {
  build(c, state, ctx) {
    const built = buildLoop(withModules(c), state, ctx.warn);
    ctx.scene.loops.push(built.loop);
    ctx.scene.snapPoints.push(...built.snapPoints);
    for (const [moverId, frame] of built.carriers) ctx.carriers.set(carrierKey(c.id, moverId), frame);
    for (const f of built.faults) ctx.addFault(c.id, f.part, f.message, f.anchor);
    ctx.addGripper(c, built.grippers);
    ctx.addZones(c);
  },
  interpolate(a, b, f, c) {
    const perimeter = trackLength(withModules(c).modules);
    const next = new Map(b.movers.map((m) => [m.id, m]));
    return {
      ...a,
      movers: a.movers.map((m) => {
        const n = next.get(m.id);
        return n
          ? { ...m, position: lerpWrapped(m.position, n.position, f, perimeter), fingers: lerpFingers(m.fingers, n.fingers, f) }
          : m;
      }),
    };
  },
};

/** Mover frames of an XTS loop, its track, snap points and the frames products hang from. */
function buildLoop(c: XtsLoopConfig, state: XtsLoopState | undefined, warn: (message: string) => void) {
  const frame = frameFromPose(c.pose);
  const owner = snapOwner(c, frame);
  // A band 40 mm thick in the track's plane, as deep as a mover is wide.
  const track = layTrack(c, state?.modules ?? [], TRACK_PLANE.xtsLoop, frame, true, {
    across: [-20, 20],
    depth: [-c.moverWidth / 2, c.moverWidth / 2],
  });
  if (track.gap > 1) warn(`${c.name}: the track modules do not close the loop (${Math.round(track.gap)} mm apart)`);
  const loopFault = faultText(state?.fault);
  const parts = new MoverParts(c.name, owner, loopFault, track.top);
  parts.snapPoints.push(...track.boundaries.map((b) => owner.atMcs(b.label, b.mcs)));
  const movers = (state?.movers ?? []).map((m): SceneLoopMover => {
    // Mover frame: +X along the tangent, +Z to the left (inside the loop), so its −Z points outwards.
    const at = track.at(m.position);
    const mover = child(frame, at.origin, mul(at.rotation, rotX(-90)));
    const tool = child(mover, [0, 0, -c.toolOffset]);
    const fault = parts.add(m, mover, tool, LABEL_LIFT.loopMover, "tool");
    return { id: m.id, transform: toRendererTransform(mover), tool: toRenderer(tool.origin), fault };
  });
  return {
    loop: {
      id: c.id,
      name: c.name,
      base: toRendererTransform(frame),
      modules: track.modules,
      label: toRenderer(track.middle),
      moverLength: c.moverLength * MM,
      moverWidth: c.moverWidth * MM,
      movers,
      fault: loopFault,
    } satisfies SceneLoop,
    snapPoints: parts.snapPoints,
    carriers: parts.carriers,
    grippers: parts.grippers,
    faults: [...parts.faults, ...track.faults],
  };
}
