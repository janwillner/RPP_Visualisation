import type { SourceInfo } from "./connection";

/** A component's name from its source's config; `fallback` (default `#id`) when the config does not list it. */
export function componentName(source: SourceInfo | undefined, id: number, fallback = `#${id}`): string {
  return source?.config?.components.find((c) => c.id === id)?.name ?? fallback;
}
