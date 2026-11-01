import { describe, expect, it } from "vitest";
import { FrameRateSampler, qualityFor } from "../src/scene/quality";

/** `seconds` frame-rate samples of `fps` each. */
const steady = (fps: number, seconds: number) => Array.from({ length: seconds }, () => fps);

describe("render quality", () => {
  it("stays high on auto while the frame rate holds, also through a short dip", () => {
    expect(qualityFor("auto", [])).toBe("high");
    expect(qualityFor("auto", steady(60, 10))).toBe("high");
    expect(qualityFor("auto", [...steady(60, 5), 30, 28, ...steady(60, 5)])).toBe("high");
  });

  it("drops to low on auto once the frame rate stays low, and does not go back when it recovers", () => {
    expect(qualityFor("auto", [...steady(60, 5), ...steady(30, 3)])).toBe("low");
    // Low quality makes it fast again; going back to high would flicker.
    expect(qualityFor("auto", [...steady(60, 5), ...steady(30, 3), ...steady(60, 30)])).toBe("low");
  });

  it("measures the frame rate second by second, leaving out the start and pauses such as a hidden tab", () => {
    const sampler = new FrameRateSampler();
    const run = (fps: number, seconds: number) => {
      for (let i = 0; i < fps * seconds; i++) sampler.frame(1 / fps);
    };
    run(10, 1); // Starting up: shaders compile, slow frames are expected.
    expect(sampler.samples).toEqual([]);
    run(60, 2);
    sampler.frame(30); // The tab was hidden for half a minute.
    run(30, 1);
    expect(sampler.samples.map(Math.round)).toEqual([60, 60, 30]);
  });

  it("always renders what was chosen by hand", () => {
    expect(qualityFor("high", steady(20, 30))).toBe("high");
    expect(qualityFor("low", steady(60, 30))).toBe("low");
  });
});
