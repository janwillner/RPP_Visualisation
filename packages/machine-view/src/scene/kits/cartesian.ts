import type { CartesianConfig, CartesianState } from "@rpp/protocol";
import { child, type Frame, frameFromPose, toMcs, toRendererTransform, type Vec3 } from "../frames";
import { cartesianFlange, faultText } from "../../machine-facts";
import type { CartesianPartKey, SceneBoxArea, SceneCartesian, SnapPoint } from "../scene-model";
import {
  boxCorners,
  carrierKey,
  type ComponentKit,
  extent,
  flatBoxSize,
  LABEL_LIFT,
  lerp,
  lerpFingers,
  lifted,
  MM,
  snapOwner,
} from "./kit";

/** A Cartesian robot: its rails, bridge, carriage and column, flange, stroke space, limit area, gripper and zones. */
export const cartesianKit: ComponentKit<"cartesian"> = {
  build(c, state, ctx) {
    const built = buildCartesian(c, state);
    ctx.scene.cartesians.push(built.cartesian);
    ctx.scene.boxAreas.push(built.area);
    ctx.scene.snapPoints.push(...built.snapPoints);
    if (built.carrier) ctx.carriers.set(carrierKey(c.id, 0), built.carrier);
    ctx.addFault(c.id, null, built.cartesian.fault, built.faultAnchor);
    ctx.addGripper(c, built.grippers);
    ctx.addLimitArea(c);
    ctx.addZones(c);
  },
  interpolate: (a, b, f) => ({
    ...a,
    x: lerp(a.x, b.x, f),
    y: lerp(a.y, b.y, f),
    z: lerp(a.z, b.z, f),
    fingers: lerpFingers(a.fingers, b.fingers, f),
  }),
};

/** Fixed part dimensions of a Cartesian robot drawing, mm; everything else follows from the strokes. */
const CARTESIAN = {
  margin: 120,
  rail: 80,
  bridgeWidth: 140,
  bridgeHeight: 100,
  carriage: [220, 220, 160] as Vec3,
  column: 90,
};

/**
 * Cartesian robot: rails along local +Y with their top at railHeight, the bridge on top of them at Y, the carriage
 * on the bridge at X and the column ending at the gripper flange (X, Y, Z). Without a Y axis (`xz`) a fixed beam at
 * Y = 0 takes the place of rails and bridge; without a Z axis (`xy`) the flange stays at zMin.
 */
function buildCartesian(c: CartesianConfig, state: CartesianState | undefined) {
  const frame = frameFromPose(c.pose);
  const owner = snapOwner(c, frame);
  const d = CARTESIAN;
  const hasY = c.axes !== "xz";
  const hasZ = c.axes !== "xy";
  const yMin = hasY ? c.yMin : 0;
  const yMax = hasY ? c.yMax : 0;
  const zMax = hasZ ? c.zMax : c.zMin;
  // The flange where the TCP limit area is checked; a missing axis stays put.
  const at = state ? cartesianFlange(c, state) : null;
  const axes = at ? { x: at[0], y: at[1], z: at[2] } : null;
  const { x, y, z } = axes ?? { x: c.xMin, y: yMin, z: zMax };
  const railX: [string, number][] = hasY
    ? [
        ["left", c.xMin - d.margin],
        ["right", c.xMax + d.margin],
      ]
    : [];
  const railStart = yMin - d.margin - d.bridgeWidth / 2;
  const railEnd = yMax + d.margin + d.bridgeWidth / 2;
  const bridgeZ = c.railHeight + d.bridgeHeight / 2;
  const columnLength = c.railHeight + d.bridgeHeight - c.zMin;
  const flange = child(frame, [x, y, z]);
  const box = (key: CartesianPartKey, at: Frame, size: Vec3) => ({
    key,
    transform: toRendererTransform(at),
    size: size.map((v) => v * MM) as Vec3,
  });
  const parts = [
    ...railX.map(([side, rx]) =>
      box(`rail ${side}` as CartesianPartKey, child(frame, [rx, (railStart + railEnd) / 2, c.railHeight - d.rail / 2]), [
        d.rail,
        railEnd - railStart,
        d.rail,
      ]),
    ),
    // Without a Y axis the beam does not travel and spans only the X stroke (no rails to reach).
    box(hasY ? "bridge" : "beam", child(frame, [(c.xMin + c.xMax) / 2, y, bridgeZ]), [
      c.xMax - c.xMin + 2 * d.margin + (hasY ? d.rail : 0),
      d.bridgeWidth,
      d.bridgeHeight,
    ]),
    box("carriage", child(frame, [x, y, bridgeZ]), d.carriage),
    box("column", child(frame, [x, y, z + columnLength / 2]), [d.column, d.column, columnLength]),
  ];

  const snapPoints: SnapPoint[] = [owner.at(`${c.name} · origin`, [0, 0, 0])];
  for (const [side, rx] of railX) {
    snapPoints.push(owner.at(`${c.name} · rail ${side}, start`, [rx, railStart, c.railHeight]));
    snapPoints.push(owner.at(`${c.name} · rail ${side}, end`, [rx, railEnd, c.railHeight]));
  }
  if (!hasY) {
    snapPoints.push(owner.at(`${c.name} · beam, X min end`, [c.xMin - d.margin, 0, c.railHeight]));
    snapPoints.push(owner.at(`${c.name} · beam, X max end`, [c.xMax + d.margin, 0, c.railHeight]));
  }
  // Reachable flange volume: a rectangle when an axis is missing.
  const zLow = c.zMin;
  const zHigh = zMax;
  snapPoints.push(
    ...boxCorners(owner, `${c.name} stroke space`, "workingAreas", [
      extent(c.xMin, c.xMax, "X min", "X max"),
      extent(yMin, yMax, "start", "end"),
      extent(zLow, zHigh, "bottom", "top"),
    ]),
  );
  if (state) snapPoints.push(owner.atMcs(`${c.name} · flange`, flange.origin, "structure", true));
  return {
    cartesian: {
      id: c.id,
      name: c.name,
      parts,
      flange: state ? toRendererTransform(flange) : null,
      gripperActive: c.fingers.length === 0 && (state?.gripperActive ?? false),
      axes,
      fault: faultText(state?.fault),
    } satisfies SceneCartesian,
    area: {
      robotId: c.id,
      transform: toRendererTransform(child(frame, [(c.xMin + c.xMax) / 2, (yMin + yMax) / 2, (zLow + zHigh) / 2])),
      size: flatBoxSize([c.xMax - c.xMin, yMax - yMin, zHigh - zLow]),
    } satisfies SceneBoxArea,
    snapPoints,
    /** A carried product without finger hangs at the flange. */
    carrier: state ? flange : undefined,
    grippers: state ? [{ moverId: 0, flange, states: state.fingers, faulted: state.fault !== null }] : [],
    /** Above the middle of the bridge's travel. */
    faultAnchor: lifted(
      toMcs(frame, [(c.xMin + c.xMax) / 2, (yMin + yMax) / 2, c.railHeight + d.bridgeHeight]),
      LABEL_LIFT.cartesian,
    ),
  };
}
