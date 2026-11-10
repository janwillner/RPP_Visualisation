import type { CameraPreset } from "./scene/SceneView";

const VIEWS: { action: CameraPreset; title: string }[] = [
  { action: "top", title: "View from above" },
  { action: "front", title: "View from the front (along +Y)" },
  { action: "side", title: "View from the side (along +X)" },
  { action: "iso", title: "Isometric view of the whole machine" },
];

/** Corners of an isometric cube in a 24 × 24 icon: its three visible faces. */
const CUBE_FACES: Record<"top" | "front" | "side", string> = {
  top: "12,3 20,7.5 12,12 4,7.5",
  front: "4,7.5 12,12 12,21 4,16.5",
  side: "12,12 20,7.5 20,16.5 12,21",
};

/** A cube with the face the view looks at filled; the iso view fills all three, shaded. */
function ViewIcon({ view }: { view: CameraPreset }) {
  const opacity = (face: keyof typeof CUBE_FACES) =>
    view === "iso" ? { top: 0.9, front: 0.55, side: 0.3 }[face] : view === face ? 0.9 : 0;
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden>
      {(Object.keys(CUBE_FACES) as (keyof typeof CUBE_FACES)[]).map((face) => (
        <polygon key={face} points={CUBE_FACES[face]} fill="currentColor" fillOpacity={opacity(face)} />
      ))}
    </svg>
  );
}

/** Camera buttons in the 3D view, so every view is reachable with one finger (no pinch needed). */
export function ViewControls({ onCamera }: { onCamera: (action: CameraPreset) => void }) {
  return (
    <div className="view-controls" role="toolbar" aria-label="Camera">
      {VIEWS.map((v) => (
        <button key={v.action} title={v.title} aria-label={v.title} onClick={() => onCamera(v.action)}>
          <ViewIcon view={v.action} />
        </button>
      ))}
    </div>
  );
}
