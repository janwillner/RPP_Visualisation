import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { Finger } from "@rpp/protocol";

/** Half the side of the shown flange area at least, mm: a gripper of 300 mm shows whole. */
const MIN_HALF_EXTENT = 150;
/** Room around the outermost finger, mm. */
const MARGIN = 20;
/** Radius of the dashed circle that marks the flange centre, mm, at most a quarter of the half extent. */
const FLANGE_RADIUS = 40;
/** Length of the drawn X and Y axes, as a share of the half extent. */
const AXIS_SHARE = 0.8;
/** A finger drawn at least this big, mm, so a thin pin can still be grabbed. */
const MIN_FINGER_RADIUS = 4;

const RAD = Math.PI / 180;

/**
 * A robot's gripper in a top view of its flange (ADR 0018): the flange frame's X to the right, its Y up, every finger a
 * circle of its diameter at its offset, a tick from its centre along its own X showing its rotation about Z. A finger
 * is dragged with the mouse or a finger; the configurator puts it on its grid, and a whole drag is one step for undo.
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
  /** Half the side of the shown square, mm: every finger with room around it. */
  const halfExtent = Math.max(
    MIN_HALF_EXTENT,
    ...fingers.map((f) => Math.max(Math.abs(f.offset.x), Math.abs(f.offset.y)) + f.diameter / 2 + MARGIN),
  );
  const axis = halfExtent * AXIS_SHARE;
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
      viewBox={`${-halfExtent} ${-halfExtent} ${2 * halfExtent} ${2 * halfExtent}`}
      onPointerMove={(e) => {
        const at = dragged.current !== undefined ? flangePoint(e) : undefined;
        if (at) props.onMove(dragged.current!, at);
      }}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <circle className="flange" cx={0} cy={0} r={Math.min(FLANGE_RADIUS, halfExtent / 4)} />
      <line className="axis" x1={0} y1={0} x2={axis} y2={0} />
      <line className="axis" x1={0} y1={0} x2={0} y2={-axis} />
      <text className="axis-label" x={axis * 1.03} y={4}>
        X
      </text>
      <text className="axis-label" x={4} y={-axis * 1.03}>
        Y
      </text>
      {fingers.map((f, i) => {
        const r = Math.max(f.diameter / 2, MIN_FINGER_RADIUS);
        const { x, y, rz } = f.offset;
        return (
          <g
            key={i}
            className="finger"
            role="button"
            aria-label={`Finger ${i + 1} at X ${x}, Y ${y} mm, turned ${rz}°`}
            transform={`translate(${x} ${-y})`}
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture?.(e.pointerId);
              dragged.current = i;
              props.onBegin();
            }}
          >
            <circle r={r} />
            {/* Its own X, turned by rz about the flange's Z. */}
            <line className="heading" x1={0} y1={0} x2={r * Math.cos(rz * RAD)} y2={-r * Math.sin(rz * RAD)} />
            <text textAnchor="middle" dominantBaseline="central">
              {i + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
