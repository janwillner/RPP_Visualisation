import { countMemberOf } from "./plc-mapping";
import { SymbolNotFoundError, type ChangedEntries, type SumReadOptions, type SymbolAccess } from "./symbol-access";

interface Entry {
  type: string;
  value: unknown;
}

/**
 * A PLC symbol table held in memory. Symbols are registered with a type name and a value;
 * member paths (`a.b.c`) and array indices (`a.b[2]`) resolve into registered values.
 */
export class InMemoryPlc implements SymbolAccess {
  private readonly symbols = new Map<string, Entry>();
  private online = true;
  /** Registers read as changes: the session, and per path and array the previous entries as JSON by id. */
  private changes: { session: string; previous: Map<string, Map<number, string>> } | undefined;

  /** Registers a symbol with a private copy of `value`; change it later through `get`. */
  define(path: string, type: string, value: unknown): void {
    this.symbols.set(path, { type, value: structuredClone(value) });
  }

  remove(path: string): void {
    this.symbols.delete(path);
  }

  /** Mutable access to a registered symbol's value, for changing the machine state. */
  get<T>(path: string): T {
    const entry = this.symbols.get(path);
    if (!entry) throw new SymbolNotFoundError(path);
    return entry.value as T;
  }

  /** Simulate losing or regaining the connection. */
  setOnline(online: boolean): void {
    this.online = online;
  }

  async read(path: string): Promise<unknown> {
    this.ensureOnline();
    return structuredClone(this.resolve(path));
  }

  async typeOf(path: string): Promise<string | undefined> {
    this.ensureOnline();
    return this.symbols.get(path)?.type;
  }

  async sumRead(paths: readonly string[], options: SumReadOptions = {}): Promise<unknown[]> {
    this.ensureOnline();
    const values = paths.map((p) => structuredClone(this.resolve(p)));
    const { changes } = options;
    if (changes === undefined) return values;
    if (this.changes?.session !== changes) this.changes = { session: changes, previous: new Map() };
    const previous = this.changes.previous;
    return values.map((v, i) => withChangedEntries(v, paths[i]!, previous));
  }

  private ensureOnline(): void {
    if (!this.online) throw new Error("PLC not reachable");
  }

  private resolve(path: string): unknown {
    const direct = this.symbols.get(path);
    if (direct) return direct.value;
    for (const [root, entry] of this.symbols) {
      if (!path.startsWith(`${root}.`) && !path.startsWith(`${root}[`)) continue;
      const rest = path.slice(root.length);
      let current: unknown = entry.value;
      for (const [, member, index] of rest.matchAll(/\.([A-Za-z_]\w*)|\[(\d+)\]/g)) {
        if (current === null || typeof current !== "object") throw new SymbolNotFoundError(path);
        const key = member ?? Number(index);
        if (!(key in (current as object))) throw new SymbolNotFoundError(path);
        current = (current as Record<string | number, unknown>)[key];
      }
      return current;
    }
    throw new SymbolNotFoundError(path);
  }
}

/**
 * A value as the ADS bridge gives it when asked for changes (ADR 0013): each counted array of entries with an `nId`
 * directly in the structure (`aProducts` with `nProductCount`) becomes `ChangedEntries`, its counted entries compared
 * with the previous read of the same path.
 */
function withChangedEntries(value: unknown, path: string, previous: Map<string, Map<number, string>>): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const structure = value as Record<string, unknown>;
  for (const [member, entries] of Object.entries(structure)) {
    const count = structure[countMemberOf(member)];
    if (!Array.isArray(entries) || typeof count !== "number") continue;
    const counted = entries.slice(0, count) as Record<string, unknown>[];
    if (!counted.every((e) => typeof e === "object" && e !== null && "nId" in e)) continue;
    const key = `${path}|${member}`;
    const before = previous.get(key);
    const now = new Map<number, string>();
    const changed: ChangedEntries = { $ids: [], $changed: [] };
    for (const e of counted) {
      const id = Number(e.nId);
      const json = JSON.stringify(e, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
      now.set(id, json);
      changed.$ids.push(id);
      if (before?.get(id) !== json) changed.$changed.push(e);
    }
    previous.set(key, now);
    structure[member] = changed;
  }
  return structure;
}
