import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Text fields that commit their value as one step: on Enter or when they lose focus, not with every key; Escape
 * restores the value. The configurator's properties and the Simulator's recipe form use them.
 */

/** Commits on Enter or when it loses focus, so typing a number is one step for undo; Escape restores the value. */
function useDraftText(value: string, commit: (text: string) => void) {
  const [text, setText] = useState(value);
  // Set by Escape: the blur that follows at once must not commit what was typed.
  const cancelled = useRef(false);
  useEffect(() => setText(value), [value]);
  return {
    value: text,
    onChange: (e: { target: { value: string } }) => setText(e.target.value),
    onBlur: () => {
      if (!cancelled.current && text !== value) commit(text);
      cancelled.current = false;
      // Shown as the value is, also when the text meant the same (2000.0) or was refused; a changed value follows.
      setText(value);
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") e.currentTarget.blur();
      if (e.key === "Escape") {
        cancelled.current = true;
        e.currentTarget.blur();
      }
    },
  };
}

export function NumberInput(props: { value: number; integer: boolean; label: string; onCommit: (value: number) => void }) {
  const input = useDraftText(String(props.value), (text) => {
    const n = Number(text.replace(",", "."));
    if (text.trim() !== "" && Number.isFinite(n) && (!props.integer || Number.isInteger(n))) props.onCommit(n);
  });
  return <input type="text" inputMode="decimal" aria-label={props.label} {...input} />;
}

export function TextInput(props: { value: string; label: string; onCommit: (value: string) => void }) {
  const input = useDraftText(props.value, props.onCommit);
  return <input type="text" aria-label={props.label} {...input} />;
}
