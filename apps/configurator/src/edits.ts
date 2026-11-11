import type { ComponentConfig, Draft } from "@rpp/protocol";
import { componentKey, type ComponentKey } from "@rpp/machine-view";

/**
 * Every change to a draft is one edit, applied by `applyEdit` without touching the draft it is given: the configurator
 * keeps the drafts before it for undo.
 */
export type Edit =
  | { kind: "add"; component: ComponentConfig }
  | { kind: "remove"; key: ComponentKey }
  | { kind: "rename"; name: string }
  /** The components of one source replaced by these, e.g. imported from its PLC; they go after the others. */
  | { kind: "replaceSource"; sourceId: string; components: readonly ComponentConfig[] }
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
    case "replaceSource":
      return {
        ...draft,
        components: [...draft.components.filter((c) => c.sourceId !== edit.sourceId), ...edit.components],
      };
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

/**
 * A copy of `target` with the value at `path` replaced; the objects and lists along the path are copied, nothing is
 * changed. A list entry is named by its index, e.g. `["zones", "1", "end"]`.
 */
function setIn(target: unknown, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [string, ...string[]];
  if (Array.isArray(target)) {
    const list = [...target];
    list[Number(head)] = setIn(list[Number(head)], rest, value);
    return list;
  }
  const object = target as Record<string, unknown>;
  return { ...object, [head]: setIn(object[head], rest, value) };
}
