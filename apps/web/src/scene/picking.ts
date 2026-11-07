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

/** Where a 3D point lies on screen (CSS pixels) and how far from the camera; undefined outside the view. */
export type Projection = (position: readonly [number, number, number]) => { screen: ScreenPoint; depth: number } | undefined;

/**
 * The item under the pointer: every item projected to the screen, the nearest within the pointer type's snap radius
 * (on the same spot the one nearer to the camera).
 */
export function pickOnScreen<T extends { position: readonly [number, number, number] }>(
  items: Iterable<T>,
  pointer: ScreenPoint,
  pointerType: string,
  project: Projection,
): T | undefined {
  const candidates: { item: T; screen: ScreenPoint; depth: number }[] = [];
  for (const item of items) {
    const projected = project(item.position);
    if (projected) candidates.push({ item, ...projected });
  }
  return nearestOnScreen(candidates, pointer, snapRadiusPx(pointerType));
}

/** One pointer event, as far as a press needs it; `x`, `y` in CSS pixels on any fixed origin. */
export interface PointerSample {
  pointerId: number;
  pointerType: string;
  x: number;
  y: number;
  /** `PointerEvent.button`; 0 (primary) if absent. */
  button?: number;
}

export interface PressOptions {
  /** A finger may slide to adjust its choice: a one-finger touch is a tap wherever it is lifted. */
  touchSlides?: boolean;
  /** Only a press of the primary button (any touch or pen) can be a tap. */
  primaryOnly?: boolean;
}

/**
 * Follows the presses on the 3D view and tells which of them are taps, the same for mouse, pen and touch. A press
 * lasts from the first pointer down to the last one up. It is no tap once a second pointer joins (a pinch), a pointer
 * is cancelled (the browser took over the touch), or it travelled too far (a camera drag).
 */
export class PressTracker {
  private readonly down = new Set<number>();
  private press: { start: ScreenPoint; pointerType: string; spoiled: boolean } | undefined;
  private tapped = true;

  constructor(private readonly options: PressOptions = {}) {}

  /** Pointers down right now. */
  get pointers(): number {
    return this.down.size;
  }

  isDown(pointerId: number): boolean {
    return this.down.has(pointerId);
  }

  /** Whether the last finished press was a tap; true before the first. */
  get lastWasTap(): boolean {
    return this.tapped;
  }

  pointerDown(e: PointerSample): void {
    // Down again without having come up: its release went elsewhere (e.g. off the canvas). Start afresh.
    if (this.down.has(e.pointerId)) this.down.clear();
    if (this.down.size > 0 && this.press) this.press.spoiled = true;
    else {
      const secondary = this.options.primaryOnly === true && (e.button ?? 0) !== 0;
      this.press = { start: { x: e.x, y: e.y }, pointerType: e.pointerType, spoiled: secondary };
    }
    this.down.add(e.pointerId);
  }

  /** A pointer lifted; where the press was a tap, if it ends one. */
  pointerUp(e: PointerSample): ScreenPoint | undefined {
    if (!this.down.delete(e.pointerId) || this.down.size > 0) return undefined;
    const press = this.press;
    this.press = undefined;
    if (!press) return undefined;
    const at = { x: e.x, y: e.y };
    const slid = this.options.touchSlides === true && press.pointerType === "touch";
    this.tapped = !press.spoiled && (slid || isTap(press.start, at, press.pointerType));
    return this.tapped ? at : undefined;
  }

  pointerCancel(pointerId: number): void {
    if (!this.down.delete(pointerId)) return;
    if (this.press) this.press.spoiled = true;
    if (this.down.size > 0) return;
    this.press = undefined;
    this.tapped = false;
  }
}
