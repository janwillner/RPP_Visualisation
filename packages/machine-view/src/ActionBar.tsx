import type { ReactNode } from "react";

/**
 * An app's commands as icon buttons at the bottom right of the 3D view, like the visualisation's measure button:
 * groups side by side, right-aligned; where the view is too narrow, the later groups move to a row above.
 */
export function ActionBar({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="action-bar" role="toolbar" aria-label={label}>
      {children}
    </div>
  );
}

/** Buttons that belong together, set apart from the other groups. */
export function ActionGroup({ children }: { children: ReactNode }) {
  return <div className="action-group">{children}</div>;
}

/** One command as an icon: `label` names it for assistive technology, `title` (default `label`) is its tooltip. */
export function ActionButton({
  label,
  title = label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button aria-label={label} title={title} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}
