/** The kit of every component drawn only from the bodies it describes (ADR 0007). */
import type { Body, BodyRole, BodyState, ComponentConfig } from "@rpp/protocol";
import { child, frameFromPose, toMcs, toRendererTransform, type Vec3 } from "../frames";
import { faultText } from "../../machine-facts";
import {
  type BuildContext,
  type ComponentKit,
  type ConfigOf,
  LABEL_LIFT,
  lifted,
  MM,
  shiftOf,
  snapOwner,
  type StateOf,
} from "./kit";

/** Component types drawn only from the bodies they describe: every type whose config has bodies. */
type BodyComponentType = Extract<ComponentConfig, { bodies: unknown }>["type"];

/** Roles drawn as overlays: on the zones layer, also for their snap points. */
const OVERLAY_ROLES: ReadonlySet<BodyRole> = new Set(["beam", "fieldOfView"]);

/** "fieldOfView" → "field of view". */
const roleText = (role: BodyRole) => role.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

/**
 * A component drawn only from the bodies, zones and fault it reports, e.g. a vision system, a product sensor or a
 * station: the scene needs to know nothing else about it.
 */
export function bodyKit<T extends BodyComponentType>(): ComponentKit<T> {
  return { build: buildFromBodies };
}

function buildFromBodies(
  c: ConfigOf<BodyComponentType>,
  state: StateOf<BodyComponentType> | undefined,
  ctx: BuildContext,
): void {
  const frame = frameFromPose(c.pose);
  const fault = faultText(state?.fault);
  const owner = snapOwner(c, frame);
  ctx.scene.snapPoints.push(owner.at(`${c.name} · origin`, shiftOf(c)));
  let top: Vec3 = frame.origin;
  c.bodies.forEach((b: Body, i) => {
    const bottom = child(frame, [b.pose.x, b.pose.y, b.pose.z], frameFromPose({ ...b.pose, x: 0, y: 0, z: 0 }).rotation);
    const bodyState: BodyState | undefined = state?.bodies[i];
    ctx.scene.bodies.push({
      key: `${c.id}:${i}`,
      componentId: c.id,
      shape: b.shape,
      role: b.role,
      transform: toRendererTransform(bottom),
      size: { length: b.length * MM, width: b.width * MM, height: b.height * MM },
      top: { length: b.topLength * MM, width: b.topWidth * MM },
      active: bodyState?.active ?? false,
      faulted: fault !== null,
    });
    const layer = OVERLAY_ROLES.has(b.role) ? "zones" : "structure";
    ctx.scene.snapPoints.push(owner.atMcs(`${c.name} · body ${i + 1} (${roleText(b.role)})`, bottom.origin, layer));
    const bodyTop = toMcs(bottom, [0, 0, b.height]);
    if (bodyTop[2] > top[2]) top = bodyTop;
  });
  ctx.addFault(c.id, null, fault, lifted(top, LABEL_LIFT.body));
  ctx.addZones(c);
}
