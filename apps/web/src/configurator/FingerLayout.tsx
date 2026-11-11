import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Finger } from "@rpp/protocol";

/** Half the side of the shown flange area at least, mm: a gripper of 300 mm shows whole. */
const MIN_HALF_EXTENT = 150;

/**
 * A robot's gripper in a top view of its flange (ADR 0018): the flange frame's X to the right, its Y up, every finger a
 * circle of its diameter at its offset. A finger is dragged with the mouse or a finger; the configurator puts it on its
 * grid, and a whole drag is one step for undo.
 */
export function FingerLayout(props: {
  fingers: readonly Finger[];
  onBegin: () => void;
  onMove: (index: number, at: { x: number; y: number }) => void;
  onEnd: () => void;
}) {
  const { fingers } = props;
  const svg = useRef<SVGSVGElement>(null);
  const dragged = useRef<number | undefined>(undefined);
  const reach = Math.max(
    MIN_HALF_EXTENT,
    ...fingers.map((f) => Math.max(Math.abs(f.offset.x), Math.abs(f.offset.y)) + f.diameter / 2 + 20),
  );
  /** The flange point under the pointer, mm; the SVG's y runs down, the flange's Y up. */
  const flangePoint = (e: ReactPointerEvent) => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return undefined;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
    return { x: p.x, y: -p.y };
  };
  const end = (e: ReactPointerEvent) => {
    if (dragged.current === undefined) return;
    dragged.current = undefined;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    props.onEnd();
  };
  return (
    <svg
      ref={svg}
      className="finger-layout"
      role="img"
      aria-label="Gripper fingers in a top view of the flange"
      viewBox={`${-reach} ${-reach} ${2 * reach} ${2 * reach}`}
      onPointerMove={(e) => {
        const at = dragged.current !== undefined ? flangePoint(e) : undefined;
        if (at) props.onMove(dragged.current!, at);
      }}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <circle className="flange" cx={0} cy={0} r={Math.min(40, reach / 4)} />
      <line className="axis x" x1={0} y1={0} x2={reach * 0.8} y2={0} />
      <line className="axis y" x1={0} y1={0} x2={0} y2={-reach * 0.8} />
      <text className="axis-label" x={reach * 0.82} y={4}>
        X
      </text>
      <text className="axis-label" x={4} y={-reach * 0.82}>
        Y
      </text>
      {fingers.map((f, i) => (
        <g
          key={i}
          className="finger"
          role="button"
          aria-label={`Finger ${i + 1} at X ${f.offset.x}, Y ${f.offset.y} mm`}
          transform={`translate(${f.offset.x} ${-f.offset.y})`}
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture?.(e.pointerId);
            dragged.current = i;
            props.onBegin();
          }}
        >
          <circle r={Math.max(f.diameter / 2, 4)} />
          <text textAnchor="middle" dominantBaseline="central">
            {i + 1}
          </text>
        </g>
      ))}
    </svg>
  );
}
