import { trackLength, type ComponentConfig, type ComponentState } from "@rpp/protocol";
import { frameFromPose, toMcs } from "../scene/frames";

/**
 * Where a robot of the draft is drawn at rest, so its gripper's fingers show at their offsets on the flange (ADR
 * 0018): a Delta with its TCP in the middle of its working area, a Cartesian robot in the middle of its strokes, an XTS
 * gantry with one mover in the middle of its track and its X axis at its lower limit, an XTS loop with one mover at
 * the start of its track. Its finger states are empty, so the scene places every finger by its offset. Undefined for a
 * component without fingers: it is drawn without a state, as before.
 */
export function restState(c: ComponentConfig): ComponentState | undefined {
  if (!("fingers" in c) || c.fingers.length === 0) return undefined;
  const base = { id: c.id, timestamp: "0", fault: null };
  switch (c.type) {
    case "delta": {
      const [x, y, z] = toMcs(frameFromPose(c.pose), [0, 0, (c.workingArea.zMin + c.workingArea.zMax) / 2]);
      const tcp = { x, y, z };
      return { type: "delta", ...base, actualTcp: tcp, setpointTcp: tcp, fingers: [] };
    }
    case "cartesian":
      return {
        type: "cartesian",
        ...base,
        x: (c.xMin + c.xMax) / 2,
        y: c.axes === "xz" ? 0 : (c.yMin + c.yMax) / 2,
        z: c.axes === "xy" ? c.zMin : (c.zMin + c.zMax) / 2,
        gripperActive: false,
        fingers: [],
      };
    case "xtsGantry": {
      const mover = { id: 1, position: trackLength(c.modules) / 2, x: c.xMin, gripperActive: false, fingers: [], fault: null };
      return { type: "xtsGantry", ...base, z: c.zMax, movers: [mover], modules: [] };
    }
    case "xtsLoop":
      return { type: "xtsLoop", ...base, movers: [{ id: 1, position: 0, fingers: [], fault: null }], modules: [] };
  }
}
