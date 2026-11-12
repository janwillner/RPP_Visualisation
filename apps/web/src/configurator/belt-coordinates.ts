import type { ConveyorConfig } from "@rpp/protocol";
import { frameFromPose, toLocal, toMcs, type Vec3 } from "../scene/frames";

/**
 * A conveyor's coordinate system, in which zones and product types are given: its pose moved by its origin shift, X
 * along the belt, Y across it, 0 on the belt surface.
 */

/** A point on the belt surface (the plane zones are drawn in) given in belt coordinates (mm) → MCS (mm). */
export function beltToMcs(belt: ConveyorConfig, x: number, y: number): Vec3 {
  return toMcs(frameFromPose(belt.pose), [x + belt.originShift.x, y + belt.originShift.y, 0]);
}

/** Where an MCS point lies over the belt, in belt coordinates (mm), seen along the belt's normal. */
export function mcsToBelt(belt: ConveyorConfig, point: { x: number; y: number; z?: number }): { x: number; y: number } {
  const [x, y] = toLocal(frameFromPose(belt.pose), [point.x, point.y, point.z ?? belt.pose.z]);
  return { x: x - belt.originShift.x, y: y - belt.originShift.y };
}

/** The belt's start and end along it, in belt coordinates (mm). */
export function beltRange(belt: ConveyorConfig): { start: number; end: number } {
  return { start: -belt.originShift.x, end: belt.length - belt.originShift.x };
}
