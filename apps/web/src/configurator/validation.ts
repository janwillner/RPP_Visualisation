import type { Draft } from "@rpp/protocol";
import { componentKey, type ComponentKey } from "../scene/scene-model";
import { keyOf } from "./edits";

/**
 * What is wrong with a draft. An error keeps it from being written to a PLC; a warning is shown and nothing more
 * (ADR 0016).
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
  const conveyors = new Set(draft.components.filter((c) => c.type === "conveyor").map(keyOf));
  for (const c of draft.components) {
    const error = (message: string) => issues.push({ severity: "error", key: keyOf(c), message: `${c.name}: ${message}` });
    if (!Number.isInteger(c.id) || c.id < 1) error("id must be a whole number from 1");
    else if (used.get(keyOf(c))! > 1) error(`id ${c.id} is used twice in source ${c.sourceId}`);
    // A zone refers to its conveyor by manifest id within the component's source.
    if ("zones" in c) {
      c.zones.forEach((zone, i) => {
        if (!conveyors.has(componentKey(c.sourceId, zone.conveyorId))) {
          error(`zone ${i + 1} lies on conveyor ${zone.conveyorId}, which source ${c.sourceId} does not have`);
        }
      });
    }
  }
  return issues;
}
