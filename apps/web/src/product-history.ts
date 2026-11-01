import type { GatewayMessage, Product } from "@rpp/protocol";
import type { SourceInfo } from "./connection";
import { isMissed } from "./scene/scene-model";

/** What happened to a product: its register state, or that it was missed or left the register. */
export type ProductStepKind = Product["state"] | "missed" | "gone";

export interface ProductStep {
  /** On the clock of whoever feeds the history: arrival time live, recording time in playback. */
  at: number;
  kind: ProductStepKind;
  text: string;
}

/** Products followed live by default; the oldest are forgotten beyond this. */
const DEFAULT_MAX_PRODUCTS = 5000;

interface Followed {
  steps: ProductStep[];
  /** State, robot, mover and finger of the previous state: a change in any of them is a step. */
  last: string;
  missed: boolean;
  gone: boolean;
}

/**
 * Follows every product through the gateway messages, for the inspector: when it entered the register, was assigned,
 * picked (by which robot, mover, finger), placed or rejected, missed, and when it left the register.
 */
export class ProductHistory {
  private readonly products = new Map<string, Followed>();
  /** Per conveyor the products in its previous register, to see which have left it. */
  private readonly registers = new Map<string, Set<string>>();

  constructor(private readonly maxProducts = DEFAULT_MAX_PRODUCTS) {}

  /** `source`: the message's source with this message applied, for the conveyor geometry and robot names. */
  add(at: number, message: GatewayMessage, source: SourceInfo | undefined): void {
    if (message.kind !== "state") return;
    const components = source?.config?.components ?? [];
    const robot = (id: number) => components.find((c) => c.id === id)?.name ?? `robot #${id}`;
    for (const c of message.components) {
      if (c.type !== "conveyor") continue;
      const conveyor = components.find((x) => x.id === c.id);
      const present = new Set<string>();
      for (const p of c.products) {
        const key = productKey(message.sourceId, c.id, p.id);
        present.add(key);
        const signature = `${p.state}:${p.robotId}:${p.moverId}:${p.fingerId}`;
        let followed = this.products.get(key);
        if (!followed || followed.gone) {
          // A product id seen again after it left starts a new history.
          followed = { steps: [], last: signature, missed: false, gone: false };
          this.products.delete(key);
          this.products.set(key, followed);
          followed.steps.push({ at, kind: p.state, text: `Entered the register (${stateText(p, robot, true)})` });
          this.forgetOldest();
        } else if (followed.last !== signature) {
          followed.last = signature;
          followed.steps.push({ at, kind: p.state, text: stateText(p, robot, false) });
        }
        if (!followed.missed && conveyor?.type === "conveyor" && isMissed(conveyor, c, p)) {
          followed.missed = true;
          followed.steps.push({ at, kind: "missed", text: "Missed: passed the belt end" });
        }
      }
      const registerKey = `${message.sourceId}|${c.id}`;
      for (const key of this.registers.get(registerKey) ?? []) {
        const followed = this.products.get(key);
        if (present.has(key) || !followed || followed.gone) continue;
        followed.gone = true;
        followed.steps.push({ at, kind: "gone", text: "Left the register" });
      }
      this.registers.set(registerKey, present);
    }
  }

  /** The steps of one product up to `until`, oldest first; empty for a product never seen (or forgotten). */
  of(sourceId: string, conveyorId: number, productId: number, until = Infinity): ProductStep[] {
    const steps = this.products.get(productKey(sourceId, conveyorId, productId))?.steps ?? [];
    return steps.filter((s) => s.at <= until);
  }

  private forgetOldest(): void {
    for (const key of this.products.keys()) {
      if (this.products.size <= this.maxProducts) return;
      this.products.delete(key);
    }
  }
}

const productKey = (sourceId: string, conveyorId: number, productId: number) => `${sourceId}|${conveyorId}|${productId}`;

/** A register state in words, e.g. "Picked by Delta 1, mover 3, finger 2"; lower case as part of a sentence. */
function stateText(p: Product, robot: (id: number) => string, inSentence: boolean): string {
  const by = p.robotId > 0 ? robot(p.robotId) : undefined;
  const carrier = [p.moverId > 0 && `mover ${p.moverId}`, p.fingerId > 0 && `finger ${p.fingerId}`].filter(Boolean);
  const text = (() => {
    switch (p.state) {
      case "detected":
        return "Detected";
      case "assigned":
        return by ? `Assigned to ${by}` : "Assigned";
      case "picked":
        return by ? `Picked by ${[by, ...carrier].join(", ")}` : "Picked";
      case "placed":
        return by ? `Placed by ${by}` : "Placed";
      case "rejected":
        return "Rejected";
    }
  })();
  return inSentence ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}
