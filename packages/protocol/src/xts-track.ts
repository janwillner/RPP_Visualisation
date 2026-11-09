import type { TrackModule } from "./model";

/**
 * Geometry of an XTS track, shared by the web scene and the simulator: its modules joined end to start in the
 * track's plane. A point in the plane is given in mm as `u` along the direction the first module starts in and `v`
 * to the left of it; `heading` is the tangent's angle from +u towards +v in degrees.
 */
export interface TrackPoint {
  u: number;
  v: number;
  heading: number;
}

/** How far a curve module turns the track, degrees. */
export const CURVE_ANGLE = 90;

const RAD = Math.PI / 180;

/** +1 for a left curve module, −1 for a right one, 0 for a straight one. */
export function moduleTurn(m: TrackModule): number {
  return m.kind === "curveLeft" ? 1 : m.kind === "curveRight" ? -1 : 0;
}

/** Radius of a curve module's track line, mm: a quarter circle as long as the module. */
export function curveRadius(m: TrackModule): number {
  return m.length / (CURVE_ANGLE * RAD);
}

export function trackLength(modules: readonly TrackModule[]): number {
  return modules.reduce((sum, m) => sum + m.length, 0);
}

/** The point `d` mm along module `m` that starts at `start`. */
export function alongModule(start: TrackPoint, m: TrackModule, d: number): TrackPoint {
  const h = start.heading * RAD;
  const turn = moduleTurn(m);
  if (turn === 0 || m.length <= 0) return { u: start.u + d * Math.cos(h), v: start.v + d * Math.sin(h), heading: start.heading };
  const r = curveRadius(m);
  const phi = d / r;
  // In the module's frame: ahead along x, turning towards y (left) or −y (right).
  const x = r * Math.sin(phi);
  const y = turn * r * (1 - Math.cos(phi));
  return {
    u: start.u + x * Math.cos(h) - y * Math.sin(h),
    v: start.v + x * Math.sin(h) + y * Math.cos(h),
    heading: start.heading + (turn * phi) / RAD,
  };
}

/** Where each module starts, and as the last entry where the track ends. */
export function moduleStarts(modules: readonly TrackModule[]): TrackPoint[] {
  const starts: TrackPoint[] = [{ u: 0, v: 0, heading: 0 }];
  for (const m of modules) starts.push(alongModule(starts[starts.length - 1]!, m, m.length));
  return starts;
}

/** Centre of a curve module's quarter circle, undefined for a straight module. */
export function curveCentre(start: TrackPoint, m: TrackModule): { u: number; v: number } | undefined {
  const turn = moduleTurn(m);
  if (turn === 0) return undefined;
  const h = start.heading * RAD;
  const r = turn * curveRadius(m);
  return { u: start.u - r * Math.sin(h), v: start.v + r * Math.cos(h) };
}

/**
 * The point at track position `s`. On a closed track (an XTS loop) positions wrap around its length; on an open one
 * they run on straight beyond either end.
 */
export function trackPoint(modules: readonly TrackModule[], s: number, closed: boolean): TrackPoint {
  return trackPoints(modules, closed)(s);
}

/** `trackPoint` for many positions on the same track: the module starts are laid out once. */
export function trackPoints(modules: readonly TrackModule[], closed: boolean): (s: number) => TrackPoint {
  const starts = moduleStarts(modules);
  const total = trackLength(modules);
  return (s) => {
    let rest = closed && total > 0 ? ((s % total) + total) % total : s;
    if (rest < 0 || modules.length === 0) return alongModule(starts[0]!, { kind: "straight", length: 0 }, rest);
    for (let i = 0; i < modules.length; i++) {
      const m = modules[i]!;
      if (rest <= m.length) return alongModule(starts[i]!, m, rest);
      rest -= m.length;
    }
    return alongModule(starts[modules.length]!, { kind: "straight", length: 0 }, rest);
  };
}
