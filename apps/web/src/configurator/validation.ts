import { moduleStarts, type ConveyorConfig, type Draft, type TrackModule } from "@rpp/protocol";
import { zoneWarnings } from "../machine-facts";
import { componentKey, type ComponentKey } from "../scene/scene-model";
import { keyOf } from "./edits";

/**
 * What is wrong with a draft. An error keeps it from being written to a PLC; a warning is shown and nothing more
 * (ADR 0016). Warnings follow the visualisation's own rules (`machine-facts.ts`), so both say the same.
 */
export interface Issue {
  severity: "error" | "warning";
  /** The component concerned. */
  key: ComponentKey;
  message: string;
  /** Set for a hint that the draft assumed other hardware than its PLC has. */
  hardware?: true;
}

export function validateDraft(draft: Draft): Issue[] {
  const issues: Issue[] = [];
  const used = new Map<ComponentKey, number>();
  for (const c of draft.components) used.set(keyOf(c), (used.get(keyOf(c)) ?? 0) + 1);
  const conveyors = new Map<ComponentKey, ConveyorConfig>();
  for (const c of draft.components) if (c.type === "conveyor" && !conveyors.has(keyOf(c))) conveyors.set(keyOf(c), c);
  for (const c of draft.components) {
    const key = keyOf(c);
    const error = (message: string) => issues.push({ severity: "error", key, message: `${c.name}: ${message}` });
    if (!Number.isInteger(c.id) || c.id < 1) error("id must be a whole number from 1");
    else if (used.get(key)! > 1) error(`id ${c.id} is used twice in source ${c.sourceId}`);
    if (c.type === "conveyor") {
      const seen = new Set<number>();
      for (const t of c.productTypes) {
        if (seen.has(t.id)) error(`product type ${t.id} is defined twice`);
        seen.add(t.id);
      }
    }
    if (c.type === "xtsGantry" || c.type === "xtsLoop") {
      if (c.modules.length === 0) error("the track has no modules");
      c.modules.forEach((m, i) => {
        if (!(m.length > 0)) error(`track module ${i + 1} has no length`);
      });
      if (c.type === "xtsLoop" && !closed(c.modules)) {
        issues.push({ severity: "warning", key, message: `${c.name}: the track does not end where it starts` });
      }
    }
    // A zone refers to its conveyor by manifest id within the component's source.
    if ("zones" in c) {
      c.zones.forEach((zone, i) => {
        const belt = conveyors.get(componentKey(c.sourceId, zone.conveyorId));
        if (!belt) error(`zone ${i + 1} lies on conveyor ${zone.conveyorId}, which source ${c.sourceId} does not have`);
        else for (const message of zoneWarnings(c.name, zone, belt)) issues.push({ severity: "warning", key, message });
      });
    }
  }
  return issues;
}

/** A track end this close to its start closes the loop, mm. */
const CLOSED_DISTANCE_MM = 1;
/** A track end heading this close to its start heading closes the loop, degrees. */
const CLOSED_HEADING_DEG = 1;

/** Whether a track ends where it starts, running on in the direction it started in: an XTS loop. */
function closed(modules: readonly TrackModule[]): boolean {
  const end = moduleStarts(modules).at(-1)!;
  const turn = (((end.heading % 360) + 540) % 360) - 180;
  return Math.hypot(end.u, end.v) < CLOSED_DISTANCE_MM && Math.abs(turn) < CLOSED_HEADING_DEG && modules.length > 0;
}
