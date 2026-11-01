import { componentName } from "./component-name";
import type { SourceInfo } from "./connection";
import type { ProductEvent } from "./product-history";

/** The metrics look back this far. */
export const METRICS_WINDOW_MS = 60_000;

export interface RobotMetrics {
  sourceId: string;
  robotId: number;
  name: string;
  picksPerMin: number;
}

export interface DetectorMetrics {
  sourceId: string;
  detectorId: number;
  name: string;
  /** Products it latched per minute. */
  detectedPerMin: number;
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
  /** Every robot that picked within the window, by source and id. */
  robots: RobotMetrics[];
  /** Every conveyor with products within the window, by source and id. */
  conveyors: ConveyorMetrics[];
  /** Every detector that latched products within the window, by source and id. */
  detectors: DetectorMetrics[];
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

  const picks = new Map<string, { sourceId: string; robotId: number; count: number }>();
  const conveyors = new Map<
    string,
    { sourceId: string; conveyorId: number; entered: number; missed: number; rejected: number }
  >();
  const detected = new Map<string, { sourceId: string; detectorId: number; count: number }>();
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
    if (e.kind === "entered") {
      conveyor.entered++;
      if (e.detectorId > 0) {
        const detectorKey = `${e.sourceId}|${e.detectorId}`;
        const detector = detected.get(detectorKey) ?? { sourceId: e.sourceId, detectorId: e.detectorId, count: 0 };
        detector.count++;
        detected.set(detectorKey, detector);
      }
    }
    else if (e.kind === "rejected") conveyor.rejected++;
    else if (e.kind === "missed") {
      conveyor.missed++;
      missed++;
    } else if (e.kind === "picked") {
      picked++;
      const robotKey = `${e.sourceId}|${e.robotId}`;
      const robot = picks.get(robotKey) ?? { sourceId: e.sourceId, robotId: e.robotId, count: 0 };
      robot.count++;
      picks.set(robotKey, robot);
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
    robots: [...picks.values()]
      .map((r) => ({
        sourceId: r.sourceId,
        robotId: r.robotId,
        name: nameOf(r.sourceId, r.robotId),
        picksPerMin: perMin(r.count),
      }))
      .sort(bySourceThen((r) => r.robotId)),
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
    detectors: [...detected.values()]
      .map((d) => ({
        sourceId: d.sourceId,
        detectorId: d.detectorId,
        name: nameOf(d.sourceId, d.detectorId),
        detectedPerMin: perMin(d.count),
      }))
      .sort(bySourceThen((d) => d.detectorId)),
  };
}
