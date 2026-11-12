import type { Layers } from "./scene/SceneView";

/** The layers in the order both apps show their toggles, with their labels. */
const LAYER_LABELS: { key: keyof Layers; label: string }[] = [
  { key: "workingAreas", label: "Working areas" },
  { key: "limitAreas", label: "Limit areas" },
  { key: "zones", label: "Zones" },
  { key: "tcpMarkers", label: "TCP markers" },
  { key: "faultLabels", label: "Fault labels" },
  { key: "origins", label: "Coordinate systems" },
];

/** The layer toggles of the 3D view in a toolbar group, the same in the visualisation and the configurator. */
export function LayerToggles({ layers, onToggle }: { layers: Layers; onToggle: (key: keyof Layers) => void }) {
  return (
    <div className="group">
      <span className="muted">Layers</span>
      {LAYER_LABELS.map(({ key, label }) => (
        <button
          key={key}
          className={layers[key] ? "toggle on" : "toggle"}
          aria-pressed={layers[key]}
          onClick={() => onToggle(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
