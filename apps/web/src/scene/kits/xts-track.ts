/** XTS tracks laid out from their modules, and the parts of their movers; shared by the XTS gantry and loop kits. */
import {
  alongModule,
  curveCentre,
  curveRadius,
  type Fault,
  type FingerState,
  moduleStarts,
  moduleTurn,
  type TrackModule,
  type TrackModuleState,
  trackPoints,
} from "@rpp/protocol";
import { apply, type Frame, type Mat3, mul, rotX, rotZ, toMcs, toRendererTransform, type Vec3 } from "../frames";
import { faultText } from "../../machine-facts";
import type { SceneTrackModule, SnapPoint } from "../scene-model";
import { type GripperSource, LABEL_LIFT, lifted, MM, type SnapOwner } from "./kit";

/**
 * The plane an XTS track lies in, as a rotation in its component's frame taking the track's u (where the first module
 * starts to run), v (to its left) and normal onto local axes. A gantry's track runs along +Y in the X-Y plane, so v is
 * −X; a loop's along +X in the X-Z plane, so v is +Z (curves to the left turn up).
 */
export const TRACK_PLANE = { xtsGantry: rotZ(90), xtsLoop: rotX(90) };

/** Cross-section of a track's modules in the module frame (across, along the normal), mm. */
type TrackSection = { across: [number, number]; depth: [number, number] };

/**
 * An XTS track laid out from its modules inside its track group (`group`: an MCS frame, e.g. a gantry lifted by Z):
 * the modules to draw, the frame at any track position (relative to the group: +X the tangent, +Y left, +Z the plane
 * normal), the module boundaries and curve centres as snap points and the top centre for the fault label.
 */
export function layTrack(
  c: { name: string; modules: TrackModule[] },
  states: readonly TrackModuleState[],
  plane: Mat3,
  group: Frame,
  closed: boolean,
  section: TrackSection,
) {
  const starts = moduleStarts(c.modules);
  const absolute = (u: number, v: number) => toMcs(group, apply(plane, [u, v, 0]));
  const faults: { part: string; message: string | null; anchor: Vec3 }[] = [];
  const inPlane = (u: number, v: number, heading: number): Frame => ({
    rotation: mul(plane, rotZ(heading)),
    origin: apply(plane, [u, v, 0]),
  });
  const modules = c.modules.map((m, i): SceneTrackModule => {
    const p = starts[i]!;
    const fault = faultText(states[i]?.fault);
    const middle = alongModule(p, m, m.length / 2);
    faults.push({ part: `Module ${i + 1}`, message: fault, anchor: lifted(absolute(middle.u, middle.v), LABEL_LIFT.module) });
    return {
      key: String(i + 1),
      index: i + 1,
      transform: toRendererTransform(inPlane(p.u, p.v, p.heading)),
      length: m.length * MM,
      radius: moduleTurn(m) === 0 ? 0 : curveRadius(m) * MM,
      turn: moduleTurn(m),
      across: [section.across[0] * MM, section.across[1] * MM],
      depth: [section.depth[0] * MM, section.depth[1] * MM],
      fault,
    };
  });
  const n = c.modules.length;
  const boundaries: { label: string; mcs: Vec3 }[] = [];
  starts.forEach((p, i) => {
    if (closed && n > 0 && i === n) return;
    const label = i === 0 ? "track start" : i === n ? "track end" : `module ${i} / ${i + 1}`;
    boundaries.push({ label: `${c.name} · ${label}`, mcs: absolute(p.u, p.v) });
  });
  c.modules.forEach((m, i) => {
    const centre = curveCentre(starts[i]!, m);
    if (centre) boundaries.push({ label: `${c.name} · module ${i + 1} curve centre`, mcs: absolute(centre.u, centre.v) });
  });
  const end = starts[n]!;
  const pointAt = trackPoints(c.modules, closed);
  // Middle and top of the module boundaries, relative to the group.
  const local = starts.map((p) => apply(plane, [p.u, p.v, 0]));
  const span = (k: number) => [Math.min(...local.map((p) => p[k]!)), Math.max(...local.map((p) => p[k]!))] as const;
  const [x, y, z] = [span(0), span(1), span(2)];
  const middle: Vec3 = [(x[0] + x[1]) / 2, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2];
  return {
    modules,
    /** Fault labels of the modules, for the build context. */
    faults,
    boundaries,
    /** How far the end of a closed track lies from its start, mm. */
    gap: closed && n > 0 ? Math.hypot(end.u, end.v) : 0,
    middle,
    /** MCS point above the middle of the track, at its highest module boundary. */
    top: toMcs(group, [middle[0], middle[1], z[1]]),
    /** The frame at a track position, relative to the group. */
    at(position: number): Frame {
      const p = pointAt(position);
      return inPlane(p.u, p.v, p.heading);
    },
  };
}

/**
 * What every XTS mover adds besides its own drawing: the frame products hang from, its gripper, its fault label and
 * its flange as a snap point. A mover counts as faulted when it or its track is.
 */
export class MoverParts {
  readonly carriers = new Map<number, Frame>();
  readonly grippers: GripperSource[] = [];
  readonly faults: { part: string | null; message: string | null; anchor: Vec3 }[];
  readonly snapPoints: SnapPoint[] = [];

  constructor(
    private readonly name: string,
    private readonly owner: SnapOwner,
    private readonly trackFault: string | null,
    trackTop: Vec3,
  ) {
    this.faults = [{ part: null, message: trackFault, anchor: lifted(trackTop, LABEL_LIFT.track) }];
  }

  /** Adds mover `m` at `mover` with its gripper at `flange`; returns its fault text. */
  add(
    m: { id: number; fault: Fault | null; fingers: FingerState[] },
    mover: Frame,
    flange: Frame,
    labelLift: number,
    flangeName: string,
  ): string | null {
    this.carriers.set(m.id, flange);
    const fault = faultText(m.fault);
    this.faults.push({ part: `Mover ${m.id}`, message: fault, anchor: lifted(mover.origin, labelLift) });
    const faulted = this.trackFault !== null || fault !== null;
    this.grippers.push({ moverId: m.id, flange, states: m.fingers, faulted });
    this.snapPoints.push(this.owner.atMcs(`${this.name} · mover ${m.id} ${flangeName}`, flange.origin, "structure", true));
    return fault;
  }
}
