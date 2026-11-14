import { useEffect, useRef, useState, type CSSProperties } from "react";
import { download, useLeaveGuard } from "@rpp/machine-view";
import { usePlayer, type Player, type PlayerSnapshot } from "./player";
import { SPEEDS, type TimelineEvent } from "./recording";
import { useViewer, type Viewer, type ViewerSnapshot } from "./viewer";

/** What the recording buttons and the player bar need: the viewer's state and commands, plus the bar's own. */
export interface RecordingControls extends ViewerSnapshot {
  viewer: Viewer;
  playback: PlayerSnapshot | undefined;
  /** Whether the recording bar is out; it comes out by itself when there is a new recording. */
  barOpen: boolean;
  toggleBar(): void;
  open(file: File): void;
  save(): void;
}

/** Binds the viewer's recordings to the page: the recording bar, files, downloads and the warning before closing. */
export function useRecordingControls(viewer: Viewer): RecordingControls {
  const view = useViewer(viewer);
  const playback = usePlayer(view.player);
  const [barOpen, setBarOpen] = useState(false);

  useEffect(() => {
    if (view.player) setBarOpen(true);
  }, [view.player]);

  // An unsaved recording is lost with the page: let the browser ask first.
  const unsaved = view.recorder !== undefined || (!view.saved && view.player !== undefined);
  useLeaveGuard(unsaved);

  return {
    ...view,
    viewer,
    playback,
    barOpen,
    toggleBar: () => setBarOpen((o) => !o),
    open: (file) => void viewer.open(file.name, async () => new Uint8Array(await file.arrayBuffer())),
    save: () => void viewer.save().then((file) => file && download(file.bytes as BlobPart, file.name)),
  };
}

/** mm:ss.s */
export function formatTime(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const minutes = Math.floor(total / 60);
  return `${String(minutes).padStart(2, "0")}:${(total - minutes * 60).toFixed(1).padStart(4, "0")}`;
}

/** Re-render at a fixed rate while `active`. */
function useTicking(active: boolean, intervalMs: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
}

/** Record / stop, bottom right in the 3D view next to the measure button. */
export function RecordButton({ controls }: { controls: RecordingControls }) {
  const { recorder, mode } = controls;
  useTicking(recorder !== undefined, 250);
  if (recorder) {
    return (
      <button className="record-toggle recording" title="Stop recording" aria-label="Stop recording" onClick={() => void controls.viewer.stopRecording()}>
        <span className="stop-icon" aria-hidden />
        <span className="record-time">
          {formatTime(recorder.durationMs)} · {(recorder.bytes / 1024 / 1024).toFixed(1)} MB
        </span>
      </button>
    );
  }
  return (
    <button
      className="record-toggle"
      title="Record the machine's motion"
      aria-label="Record"
      disabled={mode === "playback"}
      onClick={() => controls.viewer.record()}
    >
      <span className="record-icon" aria-hidden />
    </button>
  );
}

/** Replays the last minute, right of the record button; not while recording. */
export function ReplayButton({ controls }: { controls: RecordingControls }) {
  return (
    <button
      className="replay-toggle"
      title="Replay the last minute"
      aria-label="Replay the last minute"
      disabled={controls.recorder !== undefined || !controls.canReplay}
      onClick={() => void controls.viewer.replay()}
    >
      <ReplayIcon />
    </button>
  );
}

/** A counter-clockwise arrow around "60". */
function ReplayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M5.2 8.5A8 8 0 1 1 4 13" strokeLinecap="round" />
      <path d="M5.2 3.8v4.7h4.7" strokeLinecap="round" strokeLinejoin="round" />
      <text x="12.6" y="15.6" textAnchor="middle" fontSize="7.5" fontWeight="600" fill="currentColor" stroke="none">
        60
      </text>
    </svg>
  );
}

/** Opens a saved recording; the last button of the player bar. */
function OpenButton({ controls }: { controls: RecordingControls }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button title="Open a saved recording (.rpprec)" onClick={() => input.current?.click()}>
        Open
      </button>
      <input
        ref={input}
        type="file"
        accept=".rpprec"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) controls.open(file);
          e.target.value = "";
        }}
      />
    </>
  );
}

/** The small arrow left of the record button that slides the recording bar out and in (not while recording). */
export function PlayerBarToggle({ controls }: { controls: RecordingControls }) {
  if (controls.recorder) return null;
  const label = controls.barOpen ? "Hide the recording bar" : "Show the recording bar";
  return (
    <button className="player-bar-toggle" title={label} aria-label={label} aria-expanded={controls.barOpen} onClick={controls.toggleBar}>
      <span aria-hidden>{controls.barOpen ? "›" : "‹"}</span>
    </button>
  );
}

/**
 * The recording bar along the bottom of the 3D view, left of its arrow; hidden until the arrow opens it and while
 * recording. Always the whole playback bar: without a recording only Open works, and in live view any playback
 * control switches to playback.
 */
export function PlayerBar({ controls }: { controls: RecordingControls }) {
  const { player, playback, mode, recorder, barOpen } = controls;
  if (recorder || !barOpen) return null;
  const empty = !player || !playback;
  const time = playback?.time ?? 0;
  const durationMs = playback?.durationMs ?? 0;
  const playing = mode === "playback" && playback?.playing === true;
  /** Runs a playback action, going into playback first if the view is live. */
  const play = (action: (p: Player) => void) => () => {
    if (!player) return;
    if (mode === "live") controls.viewer.setMode("playback");
    action(player);
  };
  return (
    <div className={mode === "playback" && !empty ? "player-bar playing" : "player-bar"} role="toolbar" aria-label="Playback">
      <button title="Previous snapshot (←)" aria-label="Previous snapshot" disabled={empty} onClick={play((p) => p.step(-1))}>
        ◀︎
      </button>
      <button
        className="play"
        title={playing ? "Pause (Space)" : "Play (Space)"}
        aria-label={playing ? "Pause" : "Play"}
        disabled={empty}
        onClick={play((p) => p.togglePlay())}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <button title="Next snapshot (→)" aria-label="Next snapshot" disabled={empty} onClick={play((p) => p.step(1))}>
        ▶︎
      </button>
      <div className="timeline-wrap">
        <input
          className="timeline"
          type="range"
          min={0}
          max={durationMs}
          step={1}
          value={time}
          disabled={empty}
          aria-label="Playback position"
          onChange={(e) => play((p) => p.seek(Number(e.target.value)))()}
        />
        {player && durationMs > 0 && (
          <TimelineMarkers
            events={player.recording.events}
            durationMs={durationMs}
            onJump={(at) => play((p) => p.seek(at))()}
          />
        )}
      </div>
      <span className="player-time">
        {formatTime(time)} / {formatTime(durationMs)}
      </span>
      <select
        value={playback?.speed ?? 1}
        disabled={empty}
        aria-label="Playback speed"
        onChange={(e) => player?.setSpeed(Number(e.target.value))}
      >
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
      <button disabled={empty} onClick={controls.save}>
        Save
      </button>
      <OpenButton controls={controls} />
      <button className="live" disabled={mode === "live"} onClick={() => controls.viewer.setMode("live")}>
        Live
      </button>
      <button
        className="link muted"
        title="Discard the recording"
        aria-label="Discard"
        disabled={empty}
        onClick={() => controls.viewer.discard()}
      >
        ✕
      </button>
    </div>
  );
}

const EVENT_LABELS: Record<TimelineEvent["kind"], string> = {
  fault: "Fault",
  offline: "Offline",
  online: "Back online",
  missed: "Missed product",
  limit: "Limit violation",
  message: "Machine message",
};

/** A mark on the timeline per event (faults, sources offline and back, missed products); a click jumps there. */
function TimelineMarkers(props: { events: readonly TimelineEvent[]; durationMs: number; onJump: (at: number) => void }) {
  const { events, durationMs, onJump } = props;
  return (
    <div className="timeline-markers">
      {events.map((e, i) => {
        const label = `${formatTime(e.at)} · ${EVENT_LABELS[e.kind]} · ${e.text}`;
        return (
          <button
            key={i}
            className={`timeline-marker ${e.kind}`}
            style={{ "--at": e.at / durationMs } as CSSProperties}
            title={label}
            aria-label={label}
            onClick={() => onJump(e.at)}
          />
        );
      })}
    </div>
  );
}

/** Space, ←/→, PageUp/PageDown (previous / next event) and Home/End while playing back. */
export function usePlaybackKeys(controls: RecordingControls): void {
  const { player, mode } = controls;
  useEffect(() => {
    if (!player || mode !== "playback") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Typing and the speed list keep their keys; the timeline slider and buttons do not (the slider would move
      // 1 ms, a focused button would toggle a second time).
      const editable = target?.tagName === "TEXTAREA" || target?.tagName === "SELECT" || target?.isContentEditable;
      if (editable || (target instanceof HTMLInputElement && target.type !== "range")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const keys: Record<string, () => void> = {
        " ": () => player.togglePlay(),
        ArrowLeft: () => player.step(-1),
        ArrowRight: () => player.step(1),
        Home: () => player.seek(0),
        End: () => player.seek(player.recording.durationMs),
        PageUp: () => player.jumpToEvent(-1),
        PageDown: () => player.jumpToEvent(1),
      };
      const action = keys[e.key];
      if (!action) return;
      e.preventDefault();
      action();
    };
    // A button is clicked on the Space key's release; that click would undo the toggle.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " " && e.target instanceof HTMLButtonElement) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [player, mode]);
}
