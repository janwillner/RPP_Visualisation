import { useState } from "react";

/** One entry of a status list: a discovery error, a draft's problem, a machine message or fault. */
export interface StatusItem {
  text: string;
  severity: "error" | "warning" | "info";
  /** A click on the entry, e.g. selecting its component; without it the entry is plain text. */
  onSelect?: () => void;
}

const TONE = { error: "bad", warning: "warn", info: "muted" } as const;

/**
 * The count every app shows in its status bar, e.g. "2 problems", and the list it opens above the status bar: the
 * visualisation's discovery errors, the configurator's problems, the Simulator's machine messages and faults. The
 * count takes the tone of its worst entry.
 */
export function StatusList(props: { items: readonly StatusItem[]; noun: readonly [one: string, many: string]; className?: string }) {
  const { items, noun, className } = props;
  const [open, setOpen] = useState(false);
  const worst = items.find((i) => i.severity === "error") ?? items.find((i) => i.severity === "warning");
  const tone = worst ? TONE[worst.severity] : "muted";
  return (
    <>
      <button className={`${tone} link`} onClick={() => setOpen((o) => !o)}>
        {items.length} {items.length === 1 ? noun[0] : noun[1]}
      </button>
      {open && items.length > 0 && (
        <ul className={["errors", className].filter(Boolean).join(" ")}>
          {items.map((item, i) => (
            <li key={i}>
              {item.onSelect ? (
                <button className={`${TONE[item.severity]} link`} onClick={item.onSelect}>
                  {item.text}
                </button>
              ) : (
                item.text
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
