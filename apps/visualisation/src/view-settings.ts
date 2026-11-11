import type { CameraPose, Layers } from "@rpp/machine-view";

type Vec3 = [number, number, number];

/** How someone left the 3D view on this device: layers, hidden components and sources, camera. */
export interface ViewSettings {
  layers: Layers;
  /** Component keys, and source ids for whole sources. */
  hidden: string[];
  /** Undefined frames the whole machine. */
  camera: CameraPose | undefined;
}

export const DEFAULT_LAYERS: Layers = {
  workingAreas: true,
  limitAreas: true,
  zones: true,
  tcpMarkers: true,
  faultLabels: true,
  // Off: the panel PCs show the machine, not its coordinate systems (they show while measuring anyway).
  origins: false,
};

const STORAGE_KEY = "rpp.view";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/**
 * The view settings from their stored text. Anything missing or broken (an older app version, a hand-edited value)
 * falls back to its default on its own, so one bad entry does not lose the rest.
 */
export function parseViewSettings(raw: string | null): ViewSettings {
  let stored: unknown;
  try {
    stored = raw === null ? undefined : JSON.parse(raw);
  } catch {
    stored = undefined;
  }
  const s = isRecord(stored) ? stored : {};

  const layers = { ...DEFAULT_LAYERS };
  if (isRecord(s.layers)) {
    for (const key of Object.keys(DEFAULT_LAYERS) as (keyof Layers)[]) {
      const value = s.layers[key];
      if (typeof value === "boolean") layers[key] = value;
    }
  }

  const hidden = Array.isArray(s.hidden) ? s.hidden.filter((k): k is string => typeof k === "string") : [];

  let camera: CameraPose | undefined;
  if (isRecord(s.camera) && isVec3(s.camera.position) && isVec3(s.camera.target)) {
    const { position, target } = s.camera;
    // A camera at its own target has no view direction.
    if (position.some((p, i) => p !== target[i])) camera = { position, target };
  }

  return { layers, hidden, camera };
}

export function serializeViewSettings(settings: ViewSettings): string {
  return JSON.stringify(settings);
}

/** The settings remembered on this device; the defaults where storage is blocked (private window, some frames). */
export function loadViewSettings(): ViewSettings {
  try {
    return parseViewSettings(localStorage.getItem(STORAGE_KEY));
  } catch {
    return parseViewSettings(null);
  }
}

export function saveViewSettings(settings: ViewSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, serializeViewSettings(settings));
  } catch {
    // Not remembered then; the view still works.
  }
}
