import type { AcquisitionStats as AcquisitionReport, ComponentState } from "@rpp/protocol";

/** Snapshots the averages and maxima cover: about 5 s at the default 20 ms cycle. */
export const ACQUISITION_WINDOW = 250;

/** The most recent values of one measurement, up to ACQUISITION_WINDOW of them. */
class Window {
  private readonly values: number[] = [];
  private next = 0;

  add(value: number): void {
    if (this.values.length < ACQUISITION_WINDOW) this.values.push(value);
    else this.values[this.next] = value;
    this.next = (this.next + 1) % ACQUISITION_WINDOW;
  }

  get size(): number {
    return this.values.length;
  }

  spread(): { avg: number; max: number } {
    let sum = 0;
    let max = 0;
    for (const v of this.values) {
      sum += v;
      if (v > max) max = v;
    }
    return { avg: round(sum / Math.max(1, this.values.length)), max: round(max) };
  }
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * How reading one source performs, for `GET /health`: read and map times and message sizes over the most recent
 * snapshots, and two checks of every conveyor's product register that catch a register read while the PLC was
 * rearranging it (a product id twice in one snapshot, or a product missing from exactly one snapshot).
 */
export class AcquisitionStatsRecorder {
  private readonly read = new Window();
  private readonly map = new Window();
  private readonly bytes = new Window();
  private products = 0;
  private duplicates = 0;
  private flickers = 0;
  private lastAnomaly: string | undefined;
  /** Per conveyor id the product ids of the two previous snapshots, the newer one first. */
  private registers = new Map<number, [Set<number>, Set<number> | undefined]>();

  /** One state snapshot: how long reading and mapping took, and the mapped component states. */
  recordSnapshot(readMs: number, mapMs: number, components: readonly ComponentState[]): void {
    this.read.add(readMs);
    this.map.add(mapMs);
    let products = 0;
    for (const c of components) {
      if (c.type !== "conveyor") continue;
      products += c.products.length;
      this.checkRegister(c.id, c.products.map((p) => p.id));
    }
    this.products = products;
  }

  /** A state message of this source was sent to the browsers with this many bytes. */
  recordSent(bytes: number): void {
    this.bytes.add(bytes);
  }

  /** A new discovery starts new registers: products are compared from the next snapshot on. */
  restart(): void {
    this.registers = new Map();
  }

  report(): AcquisitionReport | undefined {
    if (this.read.size === 0) return undefined;
    return {
      window: this.read.size,
      readMs: this.read.spread(),
      mapMs: this.map.spread(),
      ...(this.bytes.size > 0 ? { stateBytes: this.bytes.spread() } : {}),
      products: this.products,
      duplicateProducts: this.duplicates,
      flickeringProducts: this.flickers,
      ...(this.lastAnomaly ? { lastAnomaly: this.lastAnomaly } : {}),
    };
  }

  private checkRegister(conveyorId: number, ids: number[]): void {
    const current = new Set(ids);
    if (current.size < ids.length) {
      this.duplicates += ids.length - current.size;
      const seen = new Set<number>();
      const twice = ids.find((id) => seen.has(id) || !seen.add(id));
      this.lastAnomaly = `Conveyor ${conveyorId}: product ${twice} twice in one snapshot`;
    }
    const [previous, beforePrevious] = this.registers.get(conveyorId) ?? [undefined, undefined];
    if (previous && beforePrevious) {
      for (const id of beforePrevious) {
        if (previous.has(id) || !current.has(id)) continue;
        this.flickers += 1;
        this.lastAnomaly = `Conveyor ${conveyorId}: product ${id} missing from one snapshot`;
      }
    }
    this.registers.set(conveyorId, [current, previous]);
  }
}
