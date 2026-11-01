/** What someone chose for the 3D view's render quality on this device. */
export type QualitySetting = "auto" | "high" | "low";

/** What the 3D view renders with: high has soft shadows and full resolution. */
export type Quality = "high" | "low";

/** Below this frame rate the auto setting counts a second as too slow. */
export const LOW_FPS = 45;
/** This many too slow seconds in a row switch auto to low. */
const SLOW_SECONDS = 3;

/** The first second of frames is not measured: shaders compile and textures upload then. */
const WARM_UP_S = 1;
/** A longer frame is a pause (hidden tab, sleeping device), not a slow frame, and is left out. */
const PAUSE_S = 0.5;
/** Frame times add up to whole seconds only within this. */
const ROUNDING_S = 1e-9;

/** Turns frame times into frame rates, one per second of rendering. */
export class FrameRateSampler {
  /** Oldest first. */
  readonly samples: number[] = [];
  private warmUp = WARM_UP_S;
  private time = 0;
  private frames = 0;

  /** One rendered frame that took `delta` seconds. */
  frame(delta: number): void {
    if (delta > PAUSE_S) return;
    if (this.warmUp > ROUNDING_S) {
      this.warmUp -= delta;
      return;
    }
    this.time += delta;
    this.frames++;
    if (this.time >= 1 - ROUNDING_S) {
      this.samples.push(this.frames / this.time);
      this.time = 0;
      this.frames = 0;
    }
  }
}

/**
 * The quality to render with. `fps` are the frame rates measured second by second since the view started, oldest
 * first. Auto renders high until the frame rate stays low for `SLOW_SECONDS` in a row, then low, and stays low:
 * low quality raises the frame rate again, and switching back would make it flicker between the two.
 */
export function qualityFor(setting: QualitySetting, fps: readonly number[]): Quality {
  if (setting !== "auto") return setting;
  let slow = 0;
  for (const f of fps) {
    slow = f < LOW_FPS ? slow + 1 : 0;
    if (slow >= SLOW_SECONDS) return "low";
  }
  return "high";
}
