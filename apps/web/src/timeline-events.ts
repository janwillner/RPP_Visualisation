import type { Fault, GatewayMessage } from "@rpp/protocol";
import type { SourceInfo } from "./connection";
import { faultText, isMissed } from "./scene/scene-model";

/**
 * Moments worth finding again in a recording, marked on its timeline: a fault appears, a source goes offline or
 * comes back, a product is missed.
 */
export type TimelineEventKind = "fault" | "offline" | "online" | "missed";

export interface TimelineEvent {
  /** ms after the recording started. */
  at: number;
  kind: TimelineEventKind;
  sourceId: string;
  /** What happened, e.g. "Infeed: product #12 missed". */
  text: string;
}

/**
 * Finds the events in the gateway messages as they are recorded. Each is marked where it starts: a fault while it
 * stays active, a missed product while it stays in the register and an offline source count once.
 */
export class EventTracker {
  readonly events: TimelineEvent[] = [];
  private readonly connected = new Map<string, boolean>();
  /** Per source the faults active in its previous state, by `componentId` or `componentId:moverId`. */
  private readonly faults = new Map<string, Set<string>>();
  /** Per source the missed products of its previous state, by `conveyorId:productId`. */
  private readonly missed = new Map<string, Set<string>>();

  constructor(initial: readonly SourceInfo[]) {
    for (const s of initial) if (s.status) this.connected.set(s.sourceId, s.status.plcConnected);
  }

  /** `source`: the message's source as it is with this message applied (name, config). */
  add(at: number, message: GatewayMessage, source: SourceInfo): void {
    const push = (kind: TimelineEventKind, text: string) =>
      this.events.push({ at, kind, sourceId: message.sourceId, text });

    if (message.kind === "status") {
      const now = message.status.plcConnected;
      const before = this.connected.get(message.sourceId);
      this.connected.set(message.sourceId, now);
      // A source first heard of while connected has not come back from anywhere.
      if (before === now || (before === undefined && now)) return;
      push(now ? "online" : "offline", `${source.name} ${now ? "online" : "offline"}`);
      return;
    }
    if (message.kind !== "state") return;

    const components = source.config?.components ?? [];
    const nameOf = (id: number) => components.find((c) => c.id === id)?.name ?? `#${id}`;
    const faults = new Set<string>();
    const missed = new Set<string>();
    const wasFaulted = this.faults.get(message.sourceId);
    const wasMissed = this.missed.get(message.sourceId);
    const fault = (key: string, name: string, f: Fault | null) => {
      if (!f) return;
      faults.add(key);
      if (!wasFaulted?.has(key)) push("fault", `${name}: ${faultText(f)}`);
    };

    for (const c of message.components) {
      fault(String(c.id), nameOf(c.id), c.fault);
      if (c.type === "xtsGantry" || c.type === "xtsLoop") {
        for (const m of c.movers) fault(`${c.id}:${m.id}`, `${nameOf(c.id)} mover ${m.id}`, m.fault);
      }
      if (c.type !== "conveyor") continue;
      const conveyor = components.find((x) => x.id === c.id);
      if (conveyor?.type !== "conveyor") continue;
      for (const p of c.products) {
        if (!isMissed(conveyor, c, p)) continue;
        const key = `${c.id}:${p.id}`;
        missed.add(key);
        if (!wasMissed?.has(key)) push("missed", `${conveyor.name}: product #${p.id} missed`);
      }
    }
    this.faults.set(message.sourceId, faults);
    this.missed.set(message.sourceId, missed);
  }
}

/** The moment of the next event after `time` (direction 1) or the previous one before it (-1); undefined if none. */
export function eventTime(events: readonly TimelineEvent[], time: number, direction: 1 | -1): number | undefined {
  if (direction === 1) return events.find((e) => e.at > time)?.at;
  let previous: number | undefined;
  for (const e of events) if (e.at < time) previous = e.at;
  return previous;
}
