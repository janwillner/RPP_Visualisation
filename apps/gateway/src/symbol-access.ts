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
  /** Read several symbols in one request. Values are returned in the order of `paths`. */
  sumRead(paths: readonly string[]): Promise<unknown[]>;
}

export class SymbolNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`Symbol not found: ${path}`);
    this.name = "SymbolNotFoundError";
  }
}
