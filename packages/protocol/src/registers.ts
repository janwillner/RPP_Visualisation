import type { Product, StateMessage } from "./model";

/**
 * Product registers as changes (ADR 0013). A conveyor's register holds up to thousands of products, of which only a
 * few change from one state to the next. A state in register form holds per conveyor only the products that changed
 * since the previous state of the same source, and `registers` lists per conveyor id the ids of the whole register in
 * order. The WebSocket sends this form to clients that ask for it (`/ws?changes=1`); recording files store it too.
 *
 * Encoder and decoder each remember the previous register of every conveyor; they stay in step as long as the decoder
 * gets every state the encoder made, in order. A state encoded `full` (every product listed) starts a decoder afresh.
 */

/** Per conveyor id its register by product id. */
type Registers = Map<number, Map<number, Product>>;

/** Two JSON values alike: the same primitives, arrays and object members (in any member order). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** Writes states of any number of sources in register form, remembering each source's previous registers. */
export class RegisterEncoder {
  private readonly sources = new Map<string, Registers>();

  /**
   * `state` in register form: per conveyor only the products that changed since the previous state of its source, or
   * every product with `full`. Remembers the registers either way.
   */
  encode(state: StateMessage, full = false): StateMessage {
    const previous = this.sources.get(state.sourceId);
    const next: Registers = new Map();
    const registers: Record<string, number[]> = {};
    const components = state.components.map((c) => {
      if (c.type !== "conveyor") return c;
      const before = full ? undefined : previous?.get(c.id);
      const register = new Map<number, Product>();
      const changed: Product[] = [];
      const ids: number[] = [];
      for (const p of c.products) {
        register.set(p.id, p);
        ids.push(p.id);
        const old = before?.get(p.id);
        if (!old || !sameValue(old, p)) changed.push(p);
      }
      next.set(c.id, register);
      registers[c.id] = ids;
      return { ...c, products: changed };
    });
    this.sources.set(state.sourceId, next);
    return { ...state, components, registers };
  }

  /** Forgets every source: the next state of each is encoded whole. */
  reset(): void {
    this.sources.clear();
  }
}

/** `state` in register form with every product listed: any decoder can take it, whatever it knew before. */
export function withRegisters(state: StateMessage): StateMessage {
  const registers: Record<string, number[]> = {};
  for (const c of state.components) if (c.type === "conveyor") registers[c.id] = c.products.map((p) => p.id);
  return { ...state, registers };
}

/** A state in register form that does not follow on from the decoder's registers. */
export class RegisterGapError extends Error {}

/** Restores states in register form to whole states, remembering each source's previous registers. */
export class RegisterDecoder {
  private readonly sources = new Map<string, Registers>();

  /**
   * The whole state: each conveyor's register in the order of `registers`, with the products it lists and the
   * unchanged ones from the previous state (the same objects). A state without `registers` is already whole; it is
   * remembered as it is. Throws a RegisterGapError for a product neither listed nor known.
   */
  decode(state: StateMessage): StateMessage {
    const previous = this.sources.get(state.sourceId);
    const next: Registers = new Map();
    const order = state.registers;
    const components = state.components.map((c) => {
      if (c.type !== "conveyor") return c;
      const ids = order?.[c.id];
      if (!ids) {
        next.set(c.id, new Map(c.products.map((p) => [p.id, p])));
        return c;
      }
      const listed = new Map(c.products.map((p) => [p.id, p]));
      const before = previous?.get(c.id);
      const register = new Map<number, Product>();
      const products = ids.map((id) => {
        const p = listed.get(id) ?? before?.get(id);
        if (!p) throw new RegisterGapError(`Product ${id} of conveyor ${c.id} (${state.sourceId}) is not known`);
        register.set(id, p);
        return p;
      });
      next.set(c.id, register);
      return { ...c, products };
    });
    this.sources.set(state.sourceId, next);
    const { registers: _, ...whole } = state;
    return { ...whole, components };
  }

  /** Forgets every source, e.g. after a new connection. */
  reset(): void {
    this.sources.clear();
  }
}
