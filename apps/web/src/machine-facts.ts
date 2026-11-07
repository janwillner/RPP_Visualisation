import type { ConveyorConfig, ConveyorState, Fault, Product } from "@rpp/protocol";
import type { SourceInfo } from "./sources";

/**
 * Rules about the machine that the 3D scene, the timeline, the product history, the metrics and the inspector all
 * follow, so that they agree: how a fault reads, where a product is and when it is missed, what a component is called.
 */

/** The message to show for a fault; the PLC may leave it empty. */
export function faultText(fault: Fault | null | undefined): string | null {
  return fault ? fault.message || "Fault" : null;
}

/** How far along the belt a product is now, mm from the conveyor's pose along its conveying direction. */
export function productBeltX(c: ConveyorConfig, state: ConveyorState, p: Product): number {
  // The latch pose is in the conveyor's coordinate system, which lies at the origin shift from its pose.
  return c.originShift.x + p.latchPose.x + (state.beltPosition - p.latchBeltPosition);
}

/**
 * A product that has passed the belt end without being picked or placed. Rejected products pass the end on purpose
 * and are not missed.
 */
export function isMissed(c: ConveyorConfig, state: ConveyorState, p: Product): boolean {
  return p.state !== "picked" && p.state !== "placed" && p.state !== "rejected" && productBeltX(c, state, p) > c.length;
}

/** A component's name from its source's config; `fallback` (default `#id`) when the config does not list it. */
export function componentName(source: SourceInfo | undefined, id: number, fallback = `#${id}`): string {
  return source?.config?.components.find((c) => c.id === id)?.name ?? fallback;
}

/** One entry of a list in a state, by the list's name: "movers" → "mover", "modules" → "module". */
export function singular(list: string): string {
  return list.endsWith("s") ? list.slice(0, -1) : list;
}
