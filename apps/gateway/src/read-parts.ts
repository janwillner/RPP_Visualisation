/**
 * A part of the gateway's cyclic sum-read (the component states, the parameter and machine FBs of Syn_Config, the
 * machine entry): its own symbol paths, how its values map, and its memory of a changes session (ADR 0013). The gateway
 * joins the parts' paths into one sum-read and hands each part its own values, so no part knows where the others are.
 */
export interface ReadPart<T> {
  /** The symbol paths it reads, in the order `map` takes their values. */
  readonly paths: readonly string[];
  /** Its result from the values read at `paths`. */
  map(raws: readonly unknown[]): T;
  /** A new changes session starts: forget what was mapped, the next read gives every entry. */
  restart(): void;
}

/** Each part's own values out of the values read at the joined `paths` of `parts`. */
export function splitByPart<P extends ReadPart<unknown>>(parts: readonly P[], raws: readonly unknown[]): Map<P, unknown[]> {
  const values = new Map<P, unknown[]>();
  let at = 0;
  for (const part of parts) {
    values.set(part, raws.slice(at, at + part.paths.length));
    at += part.paths.length;
  }
  return values;
}
