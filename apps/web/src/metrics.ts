import { componentName } from "./component-name";
import type { SourceInfo } from "./connection";
import { clientAction, type ClientAction, type ProductEvent } from "./product-history";

/** The metrics look back this far. */
export const METRICS_WINDOW_MS = 60_000;

/** The order in which a client's figures are listed. */
export const CLIENT_ACTIONS: readonly ClientAction[] = ["detected", "picked", "placed", "rejected"];

/** What one client (robot, detector, station) did with products, per minute. */
export interface ClientMetrics {
  sourceId: string;
  clientId: number;
  name: string;
  /** Only the actions it did within the window. */
  perMin: Partial<Record<ClientAction, number>>;
}

export interface ConveyorMetrics {
  sourceId: string;
  conveyorId: number;
  name: string;
  /** Products entering its register per minute. */
  inPerMin: number;
  /** Count within the window. */
  missed: number;
  /** Count within the window. */
  rejected: number;
}

export interface MachineMetrics {
  /** The time the figures cover: the window, or less while there is not yet that much data. */
  windowMs: number;
  picksPerMin: number;
  /** Count within the window. */
  missed: number;
  /** Missed of all products picked or missed, 0…1; undefined while there are none. */
  missedShare: number | undefined;
  /** Every client that did something with products within the window, by source and id. */
  clients: ClientMetrics[];
  /** Every conveyor with products within the window, by source and id. */
  conveyors: ConveyorMetrics[];
}

/**
 * Figures over the last `METRICS_WINDOW_MS` before `now` from the product events, for the inspector. `since` is when
 * the data starts (the page opened, the recording began): before a full window, rates use the time covered.
 */
export function metrics(
  events: readonly ProductEvent[],
  now: number,
  since: number,
  sources: readonly SourceInfo[],
): MachineMetrics {
  const windowMs = Math.max(1, Math.min(METRICS_WINDOW_MS, now - since));
  const perMin = (count: number) => (count * 60_000) / windowMs;
  const nameOf = (sourceId: string, id: number) => componentName(sources.find((s) => s.sourceId === sourceId), id);

  const conveyors = new Map<
    string,
    { sourceId: string; conveyorId: number; entered: number; missed: number; rejected: number }
  >();
  const clients = new Map<string, { sourceId: string; clientId: number; counts: Partial<Record<ClientAction, number>> }>();
  let picked = 0;
  let missed = 0;
  for (const e of events) {
    if (e.at <= now - windowMs || e.at > now) continue;
    const conveyorKey = `${e.sourceId}|${e.conveyorId}`;
    let conveyor = conveyors.get(conveyorKey);
    if (!conveyor) {
      conveyor = { sourceId: e.sourceId, conveyorId: e.conveyorId, entered: 0, missed: 0, rejected: 0 };
      conveyors.set(conveyorKey, conveyor);
    }
    if (e.kind === "entered") conveyor.entered++;
    else if (e.kind === "rejected") conveyor.rejected++;
    else if (e.kind === "missed") {
      conveyor.missed++;
      missed++;
    } else if (e.kind === "picked") picked++;

    const action = clientAction(e);
    if (action && e.clientId > 0) {
      const clientKey = `${e.sourceId}|${e.clientId}`;
      const client = clients.get(clientKey) ?? { sourceId: e.sourceId, clientId: e.clientId, counts: {} };
      client.counts[action] = (client.counts[action] ?? 0) + 1;
      clients.set(clientKey, client);
    }
  }

  const bySourceThen =
    <T extends { sourceId: string }>(id: (x: T) => number) =>
    (a: T, b: T) =>
      a.sourceId.localeCompare(b.sourceId) || id(a) - id(b);
  return {
    windowMs,
    picksPerMin: perMin(picked),
    missed,
    missedShare: picked + missed > 0 ? missed / (picked + missed) : undefined,
    clients: [...clients.values()]
      .map((c) => ({
        sourceId: c.sourceId,
        clientId: c.clientId,
        name: nameOf(c.sourceId, c.clientId),
        perMin: Object.fromEntries(
          Object.entries(c.counts).map(([action, count]) => [action, perMin(count)]),
        ) as Partial<Record<ClientAction, number>>,
      }))
      .sort(bySourceThen((c) => c.clientId)),
    conveyors: [...conveyors.values()]
      .map((c) => ({
        sourceId: c.sourceId,
        conveyorId: c.conveyorId,
        name: nameOf(c.sourceId, c.conveyorId),
        inPerMin: perMin(c.entered),
        missed: c.missed,
        rejected: c.rejected,
      }))
      .sort(bySourceThen((c) => c.conveyorId)),
  };
}
