/**
 * Pointer picking on screen, the same for mouse and touch: whether a press was a tap or a camera drag, and which
 * snap point lies under the pointer. A finger is less precise than a mouse, so it gets more travel and a larger
 * snap radius. All distances are CSS pixels.
 */

export interface ScreenPoint {
  x: number;
  y: number;
}

/** Pointer travel below which a press counts as a tap (click) rather than a camera drag. */
const TAP_TOLERANCE_PX = { mouse: 4, pen: 6, touch: 10 };
/** Distance from the pointer within which a snap point is picked. */
const SNAP_RADIUS_PX = { mouse: 12, pen: 20, touch: 40 };
/** Candidates closer on screen than this count as the same spot; then the one nearer to the camera wins. */
const SAME_SPOT_PX = 0.5;

type PointerKind = keyof typeof TAP_TOLERANCE_PX;

/** `PointerEvent.pointerType`; anything unknown is treated as a mouse. */
function kind(pointerType: string): PointerKind {
  return pointerType === "touch" || pointerType === "pen" ? pointerType : "mouse";
}

export function isTap(start: ScreenPoint, end: ScreenPoint, pointerType: string): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) <= TAP_TOLERANCE_PX[kind(pointerType)];
}

export function snapRadiusPx(pointerType: string): number {
  return SNAP_RADIUS_PX[kind(pointerType)];
}

/** The candidate nearest to the pointer within the radius; on the same spot the one nearer to the camera. */
export function nearestOnScreen<T>(
  candidates: readonly { item: T; screen: ScreenPoint; depth: number }[],
  pointer: ScreenPoint,
  radiusPx: number,
): T | undefined {
  let best: { item: T; px: number; depth: number } | undefined;
  for (const c of candidates) {
    const px = Math.hypot(c.screen.x - pointer.x, c.screen.y - pointer.y);
    if (px > radiusPx) continue;
    if (!best || px < best.px - SAME_SPOT_PX || (Math.abs(px - best.px) <= SAME_SPOT_PX && c.depth < best.depth)) {
      best = { item: c.item, px, depth: c.depth };
    }
  }
  return best?.item;
}
