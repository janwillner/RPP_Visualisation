import { useEffect, useMemo, useRef, useState } from "react";
import type { CameraPose, CameraPreset, Layers } from "./scene/SceneView";

type Vec3 = [number, number, number];

/** How someone left an app's 3D view on this device: layers, hidden components and sources, camera. */
export interface ViewSettings {
  layers: Layers;
  /** Component keys, and source ids for whole sources. */
  hidden: string[];
  /** Undefined frames the whole machine. */
  camera: CameraPose | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/**
 * The view settings from their stored text, the app's `defaults` for its layers. Anything missing or broken (an older
 * app version, a hand-edited value) falls back to its default on its own, so one bad entry does not lose the rest.
 */
export function parseViewSettings(raw: string | null, defaults: Layers): ViewSettings {
  let stored: unknown;
  try {
    stored = raw === null ? undefined : JSON.parse(raw);
  } catch {
    stored = undefined;
  }
  const s = isRecord(stored) ? stored : {};

  const layers = { ...defaults };
  if (isRecord(s.layers)) {
    for (const key of Object.keys(defaults) as (keyof Layers)[]) {
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

/** The settings remembered on this device under `key`; the defaults where storage is blocked (private window, frames). */
function loadViewSettings(key: string, defaults: Layers): ViewSettings {
  try {
    return parseViewSettings(localStorage.getItem(key), defaults);
  } catch {
    return parseViewSettings(null, defaults);
  }
}

function saveViewSettings(key: string, settings: ViewSettings): void {
  try {
    localStorage.setItem(key, serializeViewSettings(settings));
  } catch {
    // Not remembered then; the view still works.
  }
}

/** A request to move the camera; `seq` allows repeating the same action. */
export type CameraRequest = { action: CameraPreset; seq: number };

/** An app's 3D view state as `useMachineView` keeps it. */
export interface MachineView {
  layers: Layers;
  toggleLayer(key: keyof Layers): void;
  /** Component keys and source ids hidden by the user. */
  hidden: ReadonlySet<string>;
  toggleHidden(key: string): void;
  cameraRequest: CameraRequest;
  requestCamera(action: CameraPreset): void;
  /** Where the camera was left; undefined frames the whole machine. */
  initialCamera: CameraPose | undefined;
  rememberCamera(pose: CameraPose): void;
}

/**
 * An app's 3D view state: its layers (starting from `defaults`), the components and sources hidden in it and its
 * camera, remembered on this device under `storageKey` and back as they were left after a reload.
 */
export function useMachineView(storageKey: string, defaults: Layers): MachineView {
  const initial = useMemo(() => loadViewSettings(storageKey, defaults), [storageKey, defaults]);
  const saved = useRef<ViewSettings>(initial);
  const [layers, setLayers] = useState<Layers>(initial.layers);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set(initial.hidden));
  const [cameraRequest, setCameraRequest] = useState<CameraRequest>({ action: "iso", seq: 0 });
  useEffect(() => {
    saved.current = { ...saved.current, layers, hidden: [...hidden] };
    saveViewSettings(storageKey, saved.current);
  }, [storageKey, layers, hidden]);
  return {
    layers,
    toggleLayer: (key) => setLayers((l) => ({ ...l, [key]: !l[key] })),
    hidden,
    toggleHidden: (key) =>
      setHidden((h) => {
        const next = new Set(h);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    cameraRequest,
    requestCamera: (action) => setCameraRequest((r) => ({ action, seq: r.seq + 1 })),
    initialCamera: initial.camera,
    rememberCamera: (camera) => {
      saved.current = { ...saved.current, camera };
      saveViewSettings(storageKey, saved.current);
    },
  };
}

/** While `ask`, leaving or reloading the page asks first (something would be lost with it). */
export function useLeaveGuard(ask: boolean): void {
  useEffect(() => {
    if (!ask) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers, e.g. some HMI browser controls, ask only with a return value.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [ask]);
}
