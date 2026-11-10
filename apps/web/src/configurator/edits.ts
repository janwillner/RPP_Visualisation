import type { ComponentConfig, Draft } from "@rpp/protocol";
import { componentKey, type ComponentKey } from "../scene/scene-model";

/**
 * Every change to a draft is one edit, applied by `applyEdit` without touching the draft it is given: the configurator
 * keeps the drafts before it for undo.
 */
export type Edit =
  | { kind: "add"; component: ComponentConfig }
  | { kind: "remove"; key: ComponentKey }
  | { kind: "rename"; name: string }
  /** Sets one value of a component, found by its path of field names, e.g. `["pose", "rz"]`. */
  | { kind: "set"; key: ComponentKey; path: readonly string[]; value: unknown };

export const keyOf = (c: ComponentConfig): ComponentKey => componentKey(c.sourceId, c.id);

/**
 * The draft after `edit`. An edit of a component concerns the first one with its key: a key is unique in a valid
 * draft, and while two share one (an error), the other is reached once the first has another id.
 */
export function applyEdit(draft: Draft, edit: Edit): Draft {
  switch (edit.kind) {
    case "add":
      return { ...draft, components: [...draft.components, edit.component] };
    case "rename":
      return { ...draft, name: edit.name };
    case "remove":
    case "set": {
      const i = draft.components.findIndex((c) => keyOf(c) === edit.key);
      if (i < 0) return draft;
      const components = [...draft.components];
      if (edit.kind === "remove") components.splice(i, 1);
      else components[i] = setIn(components[i], edit.path, edit.value) as ComponentConfig;
      return { ...draft, components };
    }
  }
}

/** A copy of `target` with the value at `path` replaced; the objects along the path are copied, nothing is changed. */
function setIn(target: unknown, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [string, ...string[]];
  const object = target as Record<string, unknown>;
  return { ...object, [head]: setIn(object[head], rest, value) };
}
