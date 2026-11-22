import { useRef } from "react";
import { ActionBar, ActionButton, ActionGroup } from "@rpp/machine-view";
import { DRAFT_FILE_EXTENSION, type Configurator, type ConfiguratorSnapshot } from "./configurator";

/**
 * New, open and save the draft, undo and redo: icon buttons bottom right in the 3D view. `onSave` saves the draft as
 * a file; the page also does it on Ctrl+S.
 */
export function DraftActions({
  configurator,
  snapshot,
  onSave,
}: {
  configurator: Configurator;
  snapshot: ConfiguratorSnapshot;
  onSave: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <ActionBar label="Draft">
      <ActionGroup>
        <ActionButton label="New" onClick={() => configurator.newDraft()}>
          <Icon d="M6 3h8l4 4v14H6z M14 3v4h4" />
        </ActionButton>
        <ActionButton label="Open…" onClick={() => fileInput.current?.click()}>
          <Icon d="M3 6h6l2 2h10v11H3z" />
        </ActionButton>
        <ActionButton label="Save" title="Save (Ctrl+S)" onClick={onSave}>
          <Icon d="M4 4h13l3 3v13H4z M8 4v5h8V4 M8 20v-6h8v6" />
        </ActionButton>
        <input
          ref={fileInput}
          type="file"
          accept={`${DRAFT_FILE_EXTENSION},.json,application/json`}
          hidden
          aria-label="Open a draft file"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) configurator.open(await file.text());
          }}
        />
      </ActionGroup>
      <ActionGroup>
        <ActionButton
          label="Undo"
          title="Undo (Ctrl+Z)"
          disabled={!snapshot.canUndo}
          onClick={() => configurator.undo()}
        >
          <Icon d="M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 0 12h-3" />
        </ActionButton>
        <ActionButton
          label="Redo"
          title="Redo (Ctrl+Y)"
          disabled={!snapshot.canRedo}
          onClick={() => configurator.redo()}
        >
          <Icon d="M15 14l5-5-5-5 M20 9H10a6 6 0 0 0 0 12h3" />
        </ActionButton>
      </ActionGroup>
    </ActionBar>
  );
}

/** A 24 × 24 line icon of one path. */
function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
