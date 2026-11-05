import type { GatewayMessage, Product } from "@rpp/protocol";
import { componentName } from "./component-name";
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
 * missed. `clientId` is the client that made it happen (0 = none given, always for missed); `state` the product's
 * state afterwards, which tells how a product entered: detected, or placed there by a robot.
 */
export interface ProductEvent {
  at: number;
  sourceId: string;
  conveyorId: number;
  productId: number;
  kind: "entered" | "picked" | "placed" | "rejected" | "missed";
  clientId: number;
  state: Product["state"];
}

/** What a client did with a product, as the metrics count it. */
export type ClientAction = "detected" | "picked" | "placed" | "rejected";

/** The client's part in an event: a detector detected, a robot picked or placed, a station rejected; else none. */
export function clientAction(e: ProductEvent): ClientAction | undefined {
  if (e.kind === "missed") return undefined;
  const action = e.kind === "entered" ? e.state : e.kind;
  return action === "assigned" ? undefined : action;
}

/** Products followed live by default; the oldest are forgotten beyond this. */
const DEFAULT_MAX_PRODUCTS = 5000;

interface Followed {
  steps: ProductStep[];
  /** State, client, mover and finger of the previous state: a change in any of them is a step. */
  signature: string;
  /** Register state of the previous state: a change into picked, placed or rejected is an event. */
  state: Product["state"];
  missed: boolean;
  gone: boolean;
  /** An earlier product with the same id, which left the register before this one entered. */
  earlier?: Followed;
}

/** A product as it lay in a register's previous state, with its history. */
interface Seen {
  product: Product;
  key: string;
  followed: Followed;
}

/**
 * Follows every product through the gateway messages, for the inspector: when it entered the register, was assigned,
 * picked (by which robot, mover, finger), placed or rejected (by which client), missed, and when it left the register.
 */
export class ProductHistory {
  private readonly products = new Map<string, Followed>();
  /**
   * Per conveyor the products in its previous register by id, to see which have left it. A product that is the same
   * object as there has not changed (the register decoder keeps unchanged products, ADR 0013) and is not compared.
   */
  private readonly registers = new Map<string, Map<number, Seen>>();
  /** Product events in time order; `head` is the first one still kept. */
  private log: ProductEvent[] = [];
  private head = 0;

  /** `retainMs`: how long product events are kept for `events`. */
  constructor(
    private readonly maxProducts = DEFAULT_MAX_PRODUCTS,
    private readonly retainMs = Infinity,
  ) {}

  /** `source`: the message's source with this message applied, for the conveyor geometry and client names. */
  add(at: number, message: GatewayMessage, source: SourceInfo | undefined): void {
    if (message.kind !== "state") return;
    this.forgetEventsBefore(at - this.retainMs);
    let counting = false;
    const log = (conveyorId: number, p: Product, kind: ProductEvent["kind"], state: Product["state"] = p.state) =>
      counting &&
      this.log.push({
        at,
        sourceId: message.sourceId,
        conveyorId,
        productId: p.id,
        kind,
        clientId: kind === "missed" ? 0 : p.lastClientId,
        state,
      });
    const components = source?.config?.components ?? [];
    const nameOf = (id: number) => componentName(source, id, `client #${id}`);
    for (const c of message.components) {
      if (c.type !== "conveyor") continue;
      const conveyor = components.find((x) => x.id === c.id);
      const registerKey = `${message.sourceId}|${c.id}`;
      // What lies in a register when it is first seen did not enter or get missed now: count from its second state on.
      const before = this.registers.get(registerKey);
      counting = before !== undefined;
      const checkMissed = (followed: Followed, conveyorId: number, p: Product) => {
        if (followed.missed || conveyor?.type !== "conveyor" || !isMissed(conveyor, c, p)) return;
        followed.missed = true;
        followed.steps.push({ at, kind: "missed", text: "Missed: passed the belt end" });
        log(conveyorId, p, "missed");
      };
      const present = new Map<number, Seen>();
      for (const p of c.products) {
        const seen = before?.get(p.id);
        if (seen && seen.product === p && !seen.followed.gone) {
          // Unchanged since the previous state; only the belt has moved it on.
          present.set(p.id, seen);
          checkMissed(seen.followed, c.id, p);
          continue;
        }
        const key = seen?.key ?? productKey(message.sourceId, c.id, p.id);
        const signature = `${p.state}:${p.lastClientId}:${p.moverId}:${p.fingerId}`;
        let followed = this.products.get(key);
        if (!followed || followed.gone) {
          // A product id seen again after it left starts a new history. A recording (no product limit) keeps the
          // earlier one for earlier moments; live, only the newest is ever asked for.
          const earlier = this.maxProducts === Infinity ? followed : undefined;
          followed = { steps: [], signature, state: p.state, missed: false, gone: false, earlier };
          this.products.delete(key);
          this.products.set(key, followed);
          followed.steps.push({ at, kind: p.state, text: `Entered the register (${stateText(p, nameOf, true)})` });
          log(c.id, p, "entered");
        } else if (followed.signature !== signature) {
          followed.signature = signature;
          followed.steps.push({ at, kind: p.state, text: stateText(p, nameOf, false) });
          if (p.state !== followed.state && (p.state === "picked" || p.state === "placed" || p.state === "rejected")) {
            // Picked and placed between two states: the pick still counts.
            if (p.state === "placed" && followed.state !== "picked") log(c.id, p, "picked", "picked");
            log(c.id, p, p.state);
          }
          followed.state = p.state;
        }
        present.set(p.id, { product: p, key, followed });
        checkMissed(followed, c.id, p);
      }
      for (const [id, { followed }] of before ?? []) {
        if (present.has(id) || followed.gone) continue;
        followed.gone = true;
        followed.steps.push({ at, kind: "gone", text: "Left the register" });
      }
      this.registers.set(registerKey, present);
    }
    this.forgetOldest();
  }

  /** The steps of one product up to `until`, oldest first; empty for a product never seen (or forgotten). */
  of(sourceId: string, conveyorId: number, productId: number, until = Infinity): ProductStep[] {
    let followed = this.products.get(productKey(sourceId, conveyorId, productId));
    // In playback before a reused id came back: the earlier product's history.
    while (followed && followed.steps[0]!.at > until) followed = followed.earlier;
    return (followed?.steps ?? []).filter((s) => s.at <= until);
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

/**
 * A register state in words, naming the client that changed it, e.g. "Picked by Delta 1, mover 3, finger 2" or
 * "Rejected by Reject unit"; lower case as part of a sentence.
 */
function stateText(p: Product, nameOf: (id: number) => string, inSentence: boolean): string {
  const by = p.lastClientId > 0 ? nameOf(p.lastClientId) : undefined;
  const carrier = [p.moverId > 0 && `mover ${p.moverId}`, p.fingerId > 0 && `finger ${p.fingerId}`].filter(Boolean);
  const text = (() => {
    switch (p.state) {
      case "detected":
        // Back to detected after it was assigned: the client gave it up.
        if (p.previousState !== "detected") return by ? `Released by ${by}` : "Released";
        return by ? `Detected by ${by}` : "Detected";
      case "assigned":
        return by ? `Assigned to ${by}` : "Assigned";
      case "picked":
        return by ? `Picked by ${[by, ...carrier].join(", ")}` : "Picked";
      case "placed":
        return by ? `Placed by ${by}` : "Placed";
      case "rejected":
        return by ? `Rejected by ${by}` : "Rejected";
    }
  })();
  return inSentence ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}
