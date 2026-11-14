import { describe, expect, it } from "vitest";
import type { Layers } from "../src/scene/SceneView";
import { parseViewSettings as parse, serializeViewSettings } from "../src/view-settings";

/** The visualisation's defaults: every layer on but the coordinate systems. */
const DEFAULT_LAYERS: Layers = {
  workingAreas: true,
  limitAreas: true,
  zones: true,
  tcpMarkers: true,
  faultLabels: true,
  origins: false,
  marks: true,
};
const parseViewSettings = (raw: string | null) => parse(raw, DEFAULT_LAYERS);

describe("view settings, remembered per app and device", () => {
  it("start with the app's layers, nothing hidden, and the machine framed when nothing is stored", () => {
    expect(parseViewSettings(null)).toEqual({ layers: DEFAULT_LAYERS, hidden: [], camera: undefined });
    // Another app's defaults, e.g. the configurator's with the coordinate systems on.
    expect(parse(null, { ...DEFAULT_LAYERS, origins: true }).layers.origins).toBe(true);
  });

  it("show product marks to someone whose settings were saved before marks existed", () => {
    const before = JSON.stringify({ layers: { zones: false, origins: true }, hidden: [] });
    expect(parseViewSettings(before).layers).toEqual({ ...DEFAULT_LAYERS, zones: false, origins: true, marks: true });
    expect(parseViewSettings(JSON.stringify({ layers: { marks: false } })).layers.marks).toBe(false);
  });

  it("come back as they were saved", () => {
    const saved = {
      layers: { ...DEFAULT_LAYERS, zones: false, faultLabels: false },
      hidden: ["ads:5.1.2.3.1.1:851", "ads:127.0.0.1.1.1:852/3"],
      camera: { position: [4, 3, 4] as [number, number, number], target: [0.5, 0, -1] as [number, number, number] },
    };
    expect(parseViewSettings(serializeViewSettings(saved))).toEqual(saved);
  });

  it("fall back to the defaults for anything broken, and keep what is valid", () => {
    expect(parseViewSettings("not json")).toEqual(parseViewSettings(null));
    expect(parseViewSettings("[1,2]")).toEqual(parseViewSettings(null));

    const mixed = parseViewSettings(
      JSON.stringify({
        layers: { zones: false, tcpMarkers: "no", removedLayer: false },
        hidden: ["a", 7, null, "b"],
        camera: { position: [1, 2, "3"], target: [0, 0, 0] },
        quality: "low",
      }),
    );
    expect(mixed).toEqual({
      layers: { ...DEFAULT_LAYERS, zones: false },
      hidden: ["a", "b"],
      camera: undefined,
    });

    // A camera at its own target has no view direction.
    expect(parseViewSettings(JSON.stringify({ camera: { position: [1, 1, 1], target: [1, 1, 1] } })).camera).toBe(
      undefined,
    );
  });
});
