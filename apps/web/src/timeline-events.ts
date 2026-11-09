import type { Fault, GatewayMessage } from "@rpp/protocol";
import type { SourceInfo } from "./sources";
import { componentName, faultText, isMissed, limitViolations, singular } from "./machine-facts";

/**
 * Moments worth finding again in a recording, marked on its timeline: a fault appears, a source goes offline or
 * comes back, a product is missed, a limit violation starts.
 */
export type TimelineEventKind = "fault" | "offline" | "online" | "missed" | "limit";

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
 * stays active, a missed product while it stays in the register, a limit violation while it lasts and an offline
 * source count once.
 */
export class EventTracker {
  readonly events: TimelineEvent[] = [];
  private readonly connected = new Map<string, boolean>();
  /** Per source the faults active in its previous state, by `componentId` or `componentId:list:part`. */
  private readonly faults = new Map<string, Set<string>>();
  /** Per source the missed products of its previous state, by `conveyorId:productId`. */
  private readonly missed = new Map<string, Set<string>>();
  /** Per source the limit violations of its previous state, by their key. */
  private readonly limits = new Map<string, Set<string>>();

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
      // Nothing is known about its faults and limits while it is away: one still active when it comes back is marked
      // again.
      if (!now) {
        this.faults.delete(message.sourceId);
        this.limits.delete(message.sourceId);
      }
      push(now ? "online" : "offline", `${source.name} ${now ? "online" : "offline"}`);
      return;
    }
    if (message.kind !== "state") return;

    const components = source.config?.components ?? [];
    const nameOf = (id: number) => componentName(source, id);
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
      // Parts in a list of the state (movers, track modules) may report a fault each: named by their id if they
      // have one, else by their 1-based place in the list.
      for (const [list, entries] of Object.entries(c)) {
        if (!Array.isArray(entries)) continue;
        entries.forEach((e: unknown, i) => {
          if (typeof e !== "object" || e === null || !("fault" in e)) return;
          const part = "id" in e && typeof e.id === "number" ? e.id : i + 1;
          const name = `${nameOf(c.id)} ${singular(list)} ${part}`;
          fault(`${c.id}:${list}:${part}`, name, e.fault as Fault | null);
        });
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

    // The same rule as the 3D view, on the reported positions rather than the interpolated ones.
    const wasLimited = this.limits.get(message.sourceId);
    const limits = new Set<string>();
    const states = new Map(message.components.map((c) => [c.id, c]));
    for (const v of limitViolations(components, states).violations) {
      limits.add(v.key);
      if (!wasLimited?.has(v.key)) push("limit", v.text);
    }
    this.limits.set(message.sourceId, limits);
  }
}

/** The moment of the next event after `time` (direction 1) or the previous one before it (-1); undefined if none. */
export function eventTime(events: readonly TimelineEvent[], time: number, direction: 1 | -1): number | undefined {
  if (direction === 1) return events.find((e) => e.at > time)?.at;
  let previous: number | undefined;
  for (const e of events) if (e.at < time) previous = e.at;
  return previous;
}
