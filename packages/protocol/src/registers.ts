import type { Product, StateMessage } from "./model";

/**
 * Product registers as changes (ADR 0013). A conveyor's register holds up to thousands of products, of which only a
 * few change from one state to the next. A state in register form holds per conveyor only the products that changed
 * since the previous state of the same source, and `registers` lists per conveyor id the ids of the whole register in
 * order. The WebSocket sends this form to clients that ask for it (`/ws?changes=1`); recording files store it too.
 *
 * Encoder and decoder each remember the previous register of every conveyor; they stay in step as long as the decoder
 * gets every state the encoder made, in order. A state with every product listed (`withRegisters`) starts a decoder
 * afresh.
 */

/** How far ahead of the expected place a product is looked for before the whole register is indexed. */
const LOOKAHEAD = 8;

/**
 * A conveyor's previous register. Registers keep their order (new products at the end, removed ones drop out), so the
 * products of the next state are found by walking along it; it is indexed by id only when that fails.
 */
class Register {
  private byId?: Map<number, number>;

  constructor(readonly products: readonly Product[]) {}

  /** True once indexed: a product is then found anywhere at no extra cost. */
  get indexed(): boolean {
    return this.byId !== undefined;
  }

  /** Where the product with `id` lies, looking from `from` on first; -1 if it is not in the register. */
  indexOf(id: number, from: number): number {
    const end = Math.min(from + LOOKAHEAD, this.products.length);
    for (let j = from; j < end; j++) if (this.products[j]!.id === id) return j;
    if (!this.byId) {
      this.byId = new Map();
      // The first of two equal ids, as the walk finds it.
      for (let j = this.products.length - 1; j >= 0; j--) this.byId.set(this.products[j]!.id, j);
    }
    return this.byId.get(id) ?? -1;
  }
}

/** Per conveyor id its register. */
type Registers = Map<number, Register>;

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
   * `state` in register form: per conveyor only the products that changed since the previous state of its source
   * (every product for the first). Remembers the registers.
   */
  encode(state: StateMessage): StateMessage {
    const previous = this.sources.get(state.sourceId);
    const next: Registers = new Map();
    const registers: Record<string, number[]> = {};
    const components = state.components.map((c) => {
      if (c.type !== "conveyor") return c;
      const before = previous?.get(c.id);
      const changed: Product[] = [];
      const ids: number[] = [];
      let j = 0;
      for (const p of c.products) {
        ids.push(p.id);
        // Past the end of the previous register a product is new, unless the order changed and the register is indexed
        // already (listing an unchanged product costs only bytes).
        const k = before && (j < before.products.length || before.indexed) ? before.indexOf(p.id, j) : -1;
        if (k >= 0) j = k + 1;
        const old = k >= 0 ? before!.products[k] : undefined;
        // The same object has not changed: the gateway's mapping and the decoder keep unchanged products.
        if (!old || (old !== p && !sameValue(old, p))) changed.push(p);
      }
      next.set(c.id, new Register(c.products));
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
        next.set(c.id, new Register(c.products));
        return c;
      }
      const listed = new Map(c.products.map((p) => [p.id, p]));
      const before = previous?.get(c.id);
      let j = 0;
      const products = ids.map((id) => {
        const changed = listed.get(id);
        if (changed) {
          // Listed: changed or new (at the end); not looked for, the walk just steps over it.
          if (before?.products[j]?.id === id) j++;
          return changed;
        }
        const k = before ? before.indexOf(id, j) : -1;
        if (k >= 0) j = k + 1;
        const p = k >= 0 ? before!.products[k] : undefined;
        if (!p) throw new RegisterGapError(`Product ${id} of conveyor ${c.id} (${state.sourceId}) is not known`);
        return p;
      });
      next.set(c.id, new Register(products));
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
