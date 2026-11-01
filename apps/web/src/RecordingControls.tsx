import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { GatewayStore } from "./connection";
import { Player, usePlayer, type PlayerSnapshot } from "./player";
import {
  MAX_RECORDING_MS,
  Recorder,
  Recording,
  RecordingFileError,
  SPEEDS,
  type TimelineEvent,
} from "./recording";

export type ViewMode = "live" | "playback";

export interface RecordingControls {
  mode: ViewMode;
  /** The recorder while recording. */
  recorder: Recorder | undefined;
  /** The finished or opened recording, played by `player`. */
  player: Player | undefined;
  playback: PlayerSnapshot | undefined;
  /** False while a recording exists that was neither saved nor opened from a file. */
  saved: boolean;
  /** Set when the recording stopped by itself (length limit) or a file could not be opened. */
  notice: string | undefined;
  /** Whether the recording bar is out; it comes out by itself when there is a new recording. */
  barOpen: boolean;
  toggleBar(): void;
  start(): void;
  stop(): void;
  discard(): void;
  open(file: File): void;
  save(): void;
  setMode(mode: ViewMode): void;
  dismissNotice(): void;
}

/** Record / stop, playback and files; one recording at a time, kept in this browser tab (ADR 0006). */
export function useRecordingControls(store: GatewayStore): RecordingControls {
  const [recorder, setRecorder] = useState<Recorder>();
  const [player, setPlayer] = useState<Player>();
  const [mode, setMode] = useState<ViewMode>("live");
  const [saved, setSaved] = useState(true);
  const [notice, setNotice] = useState<string>();
  const [barOpen, setBarOpen] = useState(false);
  const unsubscribe = useRef<() => void>(undefined);
  /** The recorder being stopped: its compression is still finishing. */
  const stopping = useRef<Recorder>(undefined);
  const startedAt = useRef(0);
  const playback = usePlayer(player);

  const replaceAllowed = () =>
    saved || !player || window.confirm("Discard the current recording? It has not been saved.");

  const finish = (active: Recorder, reason?: string) => {
    if (stopping.current === active) return;
    stopping.current = active;
    unsubscribe.current?.();
    unsubscribe.current = undefined;
    // The recorder stays set until its last block is compressed, so nothing can start in between.
    void active
      .stop()
      .then((recording) => {
        setPlayer(new Player(recording));
        setSaved(false);
        setMode("playback");
        setBarOpen(true);
        if (reason) setNotice(reason);
      })
      .catch((error: unknown) => setNotice(`The recording could not be finished: ${String(error)}`))
      .finally(() => {
        stopping.current = undefined;
        setRecorder(undefined);
      });
  };

  const start = () => {
    if (recorder || !replaceAllowed()) return;
    const active = new Recorder(store.recordingContext());
    const started = performance.now();
    startedAt.current = started;
    setPlayer(undefined);
    setMode("live");
    setSaved(true);
    setNotice(undefined);
    setRecorder(active);
    unsubscribe.current = store.onMessage((message, raw, arrival) => {
      if (!active.add(arrival - started, message, raw) && active.full) finish(active, LIMIT_NOTICE);
    });
  };

  // The limit also applies while the gateway sends nothing.
  useEffect(() => {
    if (!recorder) return;
    const id = setInterval(() => {
      if (performance.now() - startedAt.current >= MAX_RECORDING_MS) finish(recorder, LIMIT_NOTICE);
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder]);

  // An unsaved recording is lost with the page: let the browser ask first.
  useEffect(() => {
    if (!recorder && (saved || !player)) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers, e.g. some HMI browser controls, ask only with a return value.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [recorder, saved, player]);

  useEffect(() => () => unsubscribe.current?.(), []);

  return {
    mode,
    recorder,
    player,
    playback,
    saved,
    notice,
    barOpen,
    toggleBar: () => setBarOpen((o) => !o),
    start,
    stop: () => recorder && finish(recorder),
    discard: () => {
      if (!replaceAllowed()) return;
      player?.pause();
      setPlayer(undefined);
      setMode("live");
      setSaved(true);
    },
    open: (file) => {
      if (recorder || !replaceAllowed()) return;
      void file
        .arrayBuffer()
        .then((bytes) => Recording.fromFile(new Uint8Array(bytes)))
        .then((recording) => {
          setPlayer(new Player(recording));
          setSaved(true);
          setMode("playback");
          setBarOpen(true);
          setNotice(undefined);
        })
        .catch((error: unknown) =>
          setNotice(error instanceof RecordingFileError ? error.message : `Cannot open ${file.name}: ${String(error)}`),
        );
    },
    save: () => {
      if (!player) return;
      void player.recording
        .toFile()
        .then((bytes) => {
          download(bytes as BlobPart, fileName(player.recording.recordedAt));
          setSaved(true);
        })
        .catch((error: unknown) => setNotice(`The recording could not be saved: ${String(error)}`));
    },
    setMode: (next) => {
      // Back to live pauses, so the playback clock does not count the time spent live.
      if (next === "live") player?.pause();
      setMode(next);
    },
    dismissNotice: () => setNotice(undefined),
  };
}

const LIMIT_NOTICE = `The recording stopped at its limit of ${MAX_RECORDING_MS / 60_000} minutes.`;

function fileName(recordedAt: string): string {
  const d = new Date(recordedAt);
  const two = (n: number) => String(n).padStart(2, "0");
  return `rpp-recording-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}.rpprec`;
}

function download(bytes: BlobPart, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
      <button className="record-toggle recording" title="Stop recording" aria-label="Stop recording" onClick={controls.stop}>
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
      onClick={controls.start}
    >
      <span className="record-icon" aria-hidden />
    </button>
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
    if (mode === "live") controls.setMode("playback");
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
      <button className="live" disabled={mode === "live"} onClick={() => controls.setMode("live")}>
        Live
      </button>
      <button
        className="link muted"
        title="Discard the recording"
        aria-label="Discard"
        disabled={empty}
        onClick={controls.discard}
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
