/**
 * The gateway's seam to a PLC. Adapters: ADS (`ads-symbol-access`) and the in-memory PLC
 * (`in-memory-plc`, also used by the simulator).
 *
 * Every operation rejects when the PLC is unreachable; the gateway treats a rejection as a lost connection.
 */
export interface SymbolAccess {
  /** Read one symbol's value. Rejects with `SymbolNotFoundError` if the path does not exist. */
  read(path: string): Promise<unknown>;
  /** PLC data type name of a symbol (e.g. `ST_VisuConveyor`), or undefined if the path does not exist. */
  typeOf(path: string): Promise<string | undefined>;
  /**
   * Read several symbols in one request. Values are returned in the order of `paths`.
   *
   * With `changes`, an adapter may give a counted array of entries with an `nId` (a product register) as
   * `ChangedEntries`: the entries that changed since its previous read in the same session. A new session (another
   * `changes` value) starts with every entry. Adapters that cannot do this return the whole arrays.
   */
  sumRead(paths: readonly string[], options?: SumReadOptions): Promise<unknown[]>;
  /**
   * Write several leaf values (numbers, switches, texts, enumerations) in one request, in the given order: the PLC
   * sees the last one written after the others (ADR 0017). An index into an array counts from 0 as in the values
   * read; the adapter maps it to the array's lower bound. Rejects with `SymbolNotFoundError` for a missing path.
   */
  sumWrite(writes: readonly SymbolWrite[]): Promise<void>;
}

export interface SumReadOptions {
  /** The session to read product registers as changes in (ADR 0013); without it every array comes whole. */
  changes?: string;
}

/**
 * A counted array as changes (ADR 0013): the ids of its counted entries in order, and the entries that are new or
 * differ from the previous read of the same session. An entry not listed is unchanged.
 */
export interface ChangedEntries {
  $ids: number[];
  $changed: Record<string, unknown>[];
}

export function isChangedEntries(value: unknown): value is ChangedEntries {
  return typeof value === "object" && value !== null && Array.isArray((value as ChangedEntries).$ids);
}

export class SymbolNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`Symbol not found: ${path}`);
    this.name = "SymbolNotFoundError";
  }
}

/** One leaf value to write, by its symbol path; array indices count from 0 as in the values read. */
export interface SymbolWrite {
  path: string;
  value: number | boolean | string;
}
