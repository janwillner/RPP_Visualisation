import type { ConveyorConfig, Draft } from "@rpp/protocol";
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
