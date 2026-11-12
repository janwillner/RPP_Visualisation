import { Client, type AdsSymbol } from "ads-client";
import { SymbolNotFoundError, type SymbolAccess } from "./symbol-access";

export interface AdsOptions {
  targetAmsNetId: string;
  targetAdsPort: number;
  /** Router address when not using the local TwinCAT router (e.g. gateway on an edge PC). */
  routerAddress?: string;
  routerTcpPort?: number;
  localAmsNetId?: string;
  localAdsPort?: number;
}

/**
 * ADS adapter for the symbol access seam, based on the community library `ads-client`.
 * Kept thin on purpose: symbol lookup, single reads, and sum-reads via `readRawMulti`.
 */
export class AdsSymbolAccess implements SymbolAccess {
  private readonly client: Client;
  private readonly symbols = new Map<string, AdsSymbol>();
  private connecting: Promise<unknown> | undefined;

  constructor(options: AdsOptions) {
    this.client = new Client({
      ...options,
      autoReconnect: true,
      objectifyEnumerations: false,
      convertDatesToJavascript: false,
    });
    // Symbol addresses can change after a PLC download, online change or restart.
    this.client.on("connect", () => this.symbols.clear());
    this.client.on("reconnect", () => this.symbols.clear());
    this.client.on("plcSymbolVersionChange", () => {
      this.symbols.clear();
      this.symbolsChanged = true;
    });
  }

  /** Set after an online change; the next sum-read fails once so the gateway rediscovers. */
  private symbolsChanged = false;

  async read(path: string): Promise<unknown> {
    await this.ensureConnected();
    const symbol = await this.symbol(path);
    if (!symbol) throw new SymbolNotFoundError(path);
    return (await this.client.readValueBySymbol(symbol)).value;
  }

  async typeOf(path: string): Promise<string | undefined> {
    await this.ensureConnected();
    return (await this.symbol(path))?.type;
  }

  async sumRead(paths: readonly string[]): Promise<unknown[]> {
    await this.ensureConnected();
    if (this.symbolsChanged) {
      this.symbolsChanged = false;
      throw new Error("PLC symbols changed (download or online change); rediscovering");
    }
    const symbols = await Promise.all(
      paths.map(async (p) => {
        const s = await this.symbol(p);
        if (!s) throw new SymbolNotFoundError(p);
        return s;
      }),
    );
    const results = await this.client.readRawMulti(
      symbols.map((s) => ({ indexGroup: s.indexGroup, indexOffset: s.indexOffset, size: s.size })),
    );
    return Promise.all(
      results.map((r, i) => {
        if (!r.success || !r.value) throw new Error(`ADS sum-read failed for ${paths[i]}: ${r.errorStr ?? "no data"}`);
        return this.client.convertFromRaw(r.value, symbols[i]!.type);
      }),
    );
  }

  /** Writing needs the array bounds and leaf types of the symbols, which only the ADS bridge resolves (ADR 0017). */
  async sumWrite(): Promise<void> {
    throw new Error("Writing parameter sets needs the ADS bridge driver (--driver ads).");
  }

  async close(): Promise<void> {
    if (this.client.connection.connected) await this.client.disconnect();
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.connection.connected) return;
    this.connecting ??= this.client.connect().finally(() => (this.connecting = undefined));
    await this.connecting;
  }

  private async symbol(path: string): Promise<AdsSymbol | undefined> {
    const cached = this.symbols.get(path);
    if (cached) return cached;
    try {
      const symbol = await this.client.getSymbol(path);
      this.symbols.set(path, symbol);
      return symbol;
    } catch (error) {
      if (!this.client.connection.connected) throw error;
      return undefined;
    }
  }
}
