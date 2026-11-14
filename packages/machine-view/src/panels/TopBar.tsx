import type { ReactNode } from "react";

/**
 * The top bar every app has: its title, left out when the page is embedded in an HMI with a header of its own, and
 * what the app puts there (layer toggles, file buttons, the source choice).
 */
export function TopBar({ title, children }: { title: string | undefined; children?: ReactNode }) {
  return (
    <header className="toolbar">
      {title !== undefined && <strong className="title">{title}</strong>}
      {children}
    </header>
  );
}
