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

/**
 * A countable moment of a product, for the metrics: it entered the register, was picked, placed or rejected, or was
 * missed. `robotId` is the robot that picked or placed it, else 0.
 */
export interface ProductEvent {
  at: number;
  sourceId: string;
  conveyorId: number;
  productId: number;
  kind: "entered" | "picked" | "placed" | "rejected" | "missed";
  robotId: number;
}

/** Products followed live by default; the oldest are forgotten beyond this. */
const DEFAULT_MAX_PRODUCTS = 5000;

interface Followed {
  steps: ProductStep[];
  /** State, robot, mover and finger of the previous state: a change in any of them is a step. */
  signature: string;
  /** Register state of the previous state: a change into picked, placed or rejected is an event. */
  state: Product["state"];
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
  /** Product events in time order; `head` is the first one still kept. */
  private log: ProductEvent[] = [];
  private head = 0;

  /** `retainMs`: how long product events are kept for `events`. */
  constructor(
    private readonly maxProducts = DEFAULT_MAX_PRODUCTS,
    private readonly retainMs = Infinity,
  ) {}

  /** `source`: the message's source with this message applied, for the conveyor geometry and robot names. */
  add(at: number, message: GatewayMessage, source: SourceInfo | undefined): void {
    if (message.kind !== "state") return;
    this.forgetEventsBefore(at - this.retainMs);
    let counting = false;
    const log = (conveyorId: number, p: Product, kind: ProductEvent["kind"]) =>
      counting &&
      this.log.push({
        at,
        sourceId: message.sourceId,
        conveyorId,
        productId: p.id,
        kind,
        robotId: kind === "picked" || kind === "placed" ? p.robotId : 0,
      });
    const components = source?.config?.components ?? [];
    const robot = (id: number) => components.find((c) => c.id === id)?.name ?? `robot #${id}`;
    for (const c of message.components) {
      if (c.type !== "conveyor") continue;
      const conveyor = components.find((x) => x.id === c.id);
      const registerKey = `${message.sourceId}|${c.id}`;
      // What lies in a register when it is first seen did not enter or get missed now: count from its second state on.
      counting = this.registers.has(registerKey);
      const present = new Set<string>();
      for (const p of c.products) {
        const key = productKey(message.sourceId, c.id, p.id);
        present.add(key);
        const signature = `${p.state}:${p.robotId}:${p.moverId}:${p.fingerId}`;
        let followed = this.products.get(key);
        if (!followed || followed.gone) {
          // A product id seen again after it left starts a new history.
          followed = { steps: [], signature, state: p.state, missed: false, gone: false };
          this.products.delete(key);
          this.products.set(key, followed);
          followed.steps.push({ at, kind: p.state, text: `Entered the register (${stateText(p, robot, true)})` });
          log(c.id, p, "entered");
        } else if (followed.signature !== signature) {
          followed.signature = signature;
          followed.steps.push({ at, kind: p.state, text: stateText(p, robot, false) });
          if (p.state !== followed.state && (p.state === "picked" || p.state === "placed" || p.state === "rejected")) {
            // Picked and placed between two states: the pick still counts.
            if (p.state === "placed" && followed.state !== "picked") log(c.id, p, "picked");
            log(c.id, p, p.state);
          }
          followed.state = p.state;
        }
        if (!followed.missed && conveyor?.type === "conveyor" && isMissed(conveyor, c, p)) {
          followed.missed = true;
          followed.steps.push({ at, kind: "missed", text: "Missed: passed the belt end" });
          log(c.id, p, "missed");
        }
      }
      for (const key of this.registers.get(registerKey) ?? []) {
        const followed = this.products.get(key);
        if (present.has(key) || !followed || followed.gone) continue;
        followed.gone = true;
        followed.steps.push({ at, kind: "gone", text: "Left the register" });
      }
      this.registers.set(registerKey, present);
    }
    this.forgetOldest();
  }

  /** The steps of one product up to `until`, oldest first; empty for a product never seen (or forgotten). */
  of(sourceId: string, conveyorId: number, productId: number, until = Infinity): ProductStep[] {
    const steps = this.products.get(productKey(sourceId, conveyorId, productId))?.steps ?? [];
    return steps.filter((s) => s.at <= until);
  }

  /** Product events from `from` to `until` (both included), in time order. */
  events(from: number, until: number): ProductEvent[] {
    const result: ProductEvent[] = [];
    for (let i = this.head; i < this.log.length; i++) {
      const e = this.log[i]!;
      if (e.at > until) break;
      if (e.at >= from) result.push(e);
    }
    return result;
  }

  private forgetEventsBefore(time: number): void {
    while (this.head < this.log.length && this.log[this.head]!.at < time) this.head++;
    // Drop the forgotten part now and then rather than shifting the array on every message.
    if (this.head > 1000 && this.head * 2 > this.log.length) {
      this.log = this.log.slice(this.head);
      this.head = 0;
    }
  }

  /** Forgets the oldest products that have left their register; one still on a belt would else count again. */
  private forgetOldest(): void {
    for (const [key, followed] of this.products) {
      if (this.products.size <= this.maxProducts) return;
      if (followed.gone) this.products.delete(key);
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
