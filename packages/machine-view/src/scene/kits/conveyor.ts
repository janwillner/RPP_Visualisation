import type { ConveyorConfig, ConveyorState, Product, ProductType } from "@rpp/protocol";
import { apply, child, type Frame, frameFromPose, rotZ, toMcs, toRendererTransform, type Vec3 } from "../frames";
import { faultText, isMissed, productBeltX } from "../../machine-facts";
import type { ProductDisplay, SceneProduct, SnapPoint } from "../scene-model";
import {
  carrierKey,
  type ComponentKit,
  LABEL_LIFT,
  lerp,
  lifted,
  MM,
  originFrame,
  shiftOf,
  sides,
  snapOwner,
  type SnapOwner,
} from "./kit";

/** A conveyor with its products: those on the belt, at a TCP, left as placeholders or missed. */
export const conveyorKit: ComponentKit<"conveyor"> = {
  late: true,
  originRank: 0,
  build(c, state, ctx) {
    const frame = frameFromPose(c.pose);
    const fault = faultText(state?.fault);
    ctx.scene.conveyors.push({
      id: c.id,
      name: c.name,
      transform: toRendererTransform(frame),
      length: c.length * MM,
      width: c.width * MM,
      axis: { originX: c.originShift.x * MM, originY: c.originShift.y * MM },
      body: c.body,
      fault,
    });
    ctx.addFault(c.id, null, fault, lifted(toMcs(frame, [c.length / 2, 0, 0]), LABEL_LIFT.conveyor));
    const owner = snapOwner(c, frame);
    const snapPoints = ctx.scene.snapPoints;
    snapPoints.push(owner.at(`${c.name} · origin`, shiftOf(c)));
    // Without a body there are no belt edges to measure from.
    if (c.body) {
      for (const end of ["start", "end"] as const) {
        for (const [side, y] of sides(c.width)) {
          snapPoints.push(owner.at(`${c.name} · ${end}, ${side}`, [end === "start" ? 0 : c.length, y, 0]));
        }
      }
    }
    snapPoints.push(owner.at(`${c.name} · end centre`, [c.length, 0, 0]));
    if (state) {
      const shown = conveyorProducts(c, frame, state, ctx.carriers, ctx.warn);
      ctx.scene.products.push(...shown);
      if (ctx.measureSnapPoints) for (const p of shown) snapPoints.push(...productSnapPoints(p, owner));
    }
  },
  interpolate: (a, b, f) => ({ ...a, beltPosition: lerp(a.beltPosition, b.beltPosition, f) }),
};

const DEFAULT_PRODUCT: ProductType = { id: 0, length: 100, width: 100, height: 100, shape: "box", cornerRadius: 0 };

/** A product type as recordings made before protocol 10 hold it, without a shape, is a box. */
function withShape(type: ProductType): ProductType {
  return { ...type, shape: type.shape ?? "box", cornerRadius: type.cornerRadius ?? 0 };
}

/** A product's bottom centre now, in the MCS and turned with the product: its latch pose moved by the belt travel. */
function productBottom(c: ConveyorConfig, state: ConveyorState, p: Product): Frame {
  const belt = originFrame(c);
  const travel = state.beltPosition - p.latchBeltPosition;
  return child(belt, [p.latchPose.x + travel, p.latchPose.y, p.latchPose.z], rotZ(p.latchPose.rz));
}

/**
 * Products of one conveyor register, positioned by latch + belt travel, with the display lifecycle:
 * - picked: a placeholder keeps travelling on the belt (until the belt end) while the product itself hangs below
 *   its carrier (robot TCP, mover or finger);
 * - placed: the product was put down onto this belt and lies on it like a detected one, but is never missed.
 */
function conveyorProducts(
  c: ConveyorConfig,
  frame: Frame,
  state: ConveyorState,
  carriers: ReadonlyMap<string, Frame>,
  warn: (message: string) => void,
): SceneProduct[] {
  const direction = apply(frame.rotation, [1, 0, 0]);
  const result: SceneProduct[] = [];
  for (const p of state.products) {
    const type = withShape(c.productTypes.find((t) => t.id === p.productType) ?? DEFAULT_PRODUCT);
    const size = { length: type.length * MM, width: type.width * MM, height: type.height * MM };
    const { rotation, origin } = productBottom(c, state, p);
    const bottom: Vec3 = [...origin];
    const shown = (display: ProductDisplay, frame: Frame): SceneProduct => ({
      key: `${c.id}:${p.id}:${display}`,
      productId: p.id,
      conveyorId: c.id,
      display,
      state: p.state,
      transform: toRendererTransform({ rotation: frame.rotation, origin: toMcs(frame, [0, 0, type.height / 2]) }),
      bottom: frame,
      size,
      shape: type.shape,
      cornerRadius: type.cornerRadius * MM,
      raw: p,
    });
    const onBelt = (display: ProductDisplay) =>
      shown(display, { rotation, origin: [bottom[0], bottom[1], bottom[2]] });

    const beltX = productBeltX(c, state, p);
    const beyondEnd = beltX > c.length;

    if (p.state === "picked") {
      if (!beyondEnd) result.push(onBelt("placeholder"));
      const flange = carriers.get(carrierKey(p.lastClientId, p.moverId));
      let carrier = p.fingerId > 0 ? carriers.get(carrierKey(p.lastClientId, p.moverId, p.fingerId)) : flange;
      if (!carrier && flange) {
        // An unknown finger: hang it at the flange so it stays visible.
        warn(`${c.name}: product #${p.id} hangs from finger ${p.fingerId}, which robot #${p.lastClientId} does not have`);
        carrier = flange;
      }
      if (carrier) {
        // Hanging from the carrier: the product's top touches the carrier origin.
        result.push(shown("atTcp", { rotation: carrier.rotation, origin: toMcs(carrier, [0, 0, -type.height]) }));
      }
      continue;
    }
    if (!beyondEnd) {
      result.push(onBelt("normal"));
    } else if (isMissed(c, state, p)) {
      // Unpicked past the end: hold it at the belt end, flagged, until the PLC drops the entry.
      const back = beltX - (c.length - type.length / 2);
      bottom[0] -= direction[0] * back;
      bottom[1] -= direction[1] * back;
      bottom[2] -= direction[2] * back;
      result.push(onBelt("missed"));
    }
  }
  return result;
}

/**
 * Points on the bottom of a drawn product (not of a placeholder), in belt coordinates: its bottom centre, and the
 * corners of a box; a cylinder or rounded box has no corners, so its outline's front, back, left and right instead.
 */
function productSnapPoints(p: SceneProduct, owner: SnapOwner): SnapPoint[] {
  if (p.display === "placeholder") return [];
  const length = p.size.length / MM;
  const width = p.size.width / MM;
  const bottom = p.bottom;
  const name = `Product #${p.productId}`;
  const point = (label: string, x: number, y: number) =>
    owner.atMcs(`${name} · ${label}`, toMcs(bottom, [x, y, 0]), "structure", true);
  const outline =
    p.shape === "box"
      ? [
          point("front left", length / 2, width / 2),
          point("front right", length / 2, -width / 2),
          point("back left", -length / 2, width / 2),
          point("back right", -length / 2, -width / 2),
        ]
      : [
          point("front", length / 2, 0),
          point("back", -length / 2, 0),
          point("left", 0, width / 2),
          point("right", 0, -width / 2),
        ];
  return [...outline, point("bottom centre", 0, 0)];
}
