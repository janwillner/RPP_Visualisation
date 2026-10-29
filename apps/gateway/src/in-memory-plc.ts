import { SymbolNotFoundError, type SymbolAccess } from "./symbol-access";

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

  async sumRead(paths: readonly string[]): Promise<unknown[]> {
    this.ensureOnline();
    return paths.map((p) => structuredClone(this.resolve(p)));
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
