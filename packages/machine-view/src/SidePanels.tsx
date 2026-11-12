import { useRef, useState, type CSSProperties } from "react";

/** Side panel width limits while dragging its edge, px. */
const PANEL_MIN_PX = 180;
const PANEL_MAX_SHARE = 0.45;

/** One side panel of an app's page: open or closed and its width, both remembered per device. */
export interface SidePanel {
  /** What the panel holds, e.g. "Components": named on its handle and its edge. */
  label: string;
  open: boolean;
  toggle: () => void;
  /** Set by dragging its edge; undefined keeps the stylesheet's width. */
  width: number | undefined;
  resize: (px: number) => void;
}

/**
 * A side panel whose open state and width are remembered on this device under `storageKey` (`.width` appended for
 * the width); `initialOpen` decides while nothing is stored. Storage may be blocked (private window, embedded
 * frame): the panel then works without remembering.
 */
export function useSidePanel(storageKey: string, label: string, initialOpen: () => boolean): SidePanel {
  const [open, setOpen] = useState(() => {
    const stored = read(storageKey);
    return stored !== null ? stored === "1" : initialOpen();
  });
  const [width, setWidth] = useState<number | undefined>(() => {
    const stored = Number(read(`${storageKey}.width`));
    return stored > 0 ? stored : undefined;
  });
  return {
    label,
    open,
    toggle: () =>
      setOpen((o) => {
        write(storageKey, o ? "0" : "1");
        return !o;
      }),
    width,
    resize: (px) => {
      const clamped = Math.round(Math.min(Math.max(px, PANEL_MIN_PX), window.innerWidth * PANEL_MAX_SHARE));
      setWidth(clamped);
      write(`${storageKey}.width`, String(clamped));
    },
  };
}

/** The `.app` element's classes and width variables for its two side panels (`--left`, `--right`). */
export function sidePanelsLayout(left: SidePanel, right: SidePanel): { className: string; style: CSSProperties } {
  return {
    className: [!left.open && "left-closed", !right.open && "right-closed"].filter(Boolean).join(" "),
    style: {
      ...(left.open && left.width && { "--left": `${left.width}px` }),
      ...(right.open && right.width && { "--right": `${right.width}px` }),
    } as CSSProperties,
  };
}

/**
 * The side panels' controls, drawn inside the 3D view's container: a tab on each edge that opens or closes the
 * panel next to it, and, next to an open panel, the edge that resizes it by dragging.
 */
export function SidePanelControls({ left, right }: { left: SidePanel; right: SidePanel }) {
  return (
    <>
      {left.open && <PanelEdge side="left" panel={left} />}
      {right.open && <PanelEdge side="right" panel={right} />}
      <PanelHandle side="left" panel={left} />
      <PanelHandle side="right" panel={right} />
    </>
  );
}

type Side = "left" | "right";

/** The 3D view's edge next to an open side panel: dragging it sets the panel's width. */
function PanelEdge({ side, panel }: { side: Side; panel: SidePanel }) {
  const drag = useRef<{ x: number; width: number }>(undefined);
  return (
    <div
      className={`panel-edge ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${panel.label.toLowerCase()}`}
      onPointerDown={(e) => {
        const element = document.querySelector(`.panel.${side}`);
        if (!element) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width: element.getBoundingClientRect().width };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const dx = e.clientX - drag.current.x;
        panel.resize(drag.current.width + (side === "left" ? dx : -dx));
      }}
      onPointerUp={() => (drag.current = undefined)}
      onPointerCancel={() => (drag.current = undefined)}
    />
  );
}

/** A tab on the 3D view's edge that opens or closes the side panel next to it. */
function PanelHandle({ side, panel }: { side: Side; panel: SidePanel }) {
  // The chevron points where the panel goes: into the edge to close, out of it to open.
  const pointsLeft = (side === "left") === panel.open;
  const action = `${panel.open ? "Hide" : "Show"} ${panel.label.toLowerCase()}`;
  return (
    <button
      className={`panel-handle ${side}`}
      title={action}
      aria-label={action}
      aria-expanded={panel.open}
      onClick={panel.toggle}
    >
      <span aria-hidden>{pointsLeft ? "‹" : "›"}</span>
    </button>
  );
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered then; the panel still works.
  }
}
