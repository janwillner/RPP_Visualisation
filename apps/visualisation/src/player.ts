import { useSyncExternalStore } from "react";
import type { StateMessage } from "@rpp/protocol";
import type { SceneFeed } from "./viewer";
import type { SceneSource, SourceInfo } from "@rpp/machine-view";
import { eventTime, playFrom, seek, step, tick, type PlaybackClock, type PlaybackView, type Recording } from "./recording";

/** The player UI re-renders at most this often while playing. */
const UI_INTERVAL_MS = 100;

export interface PlayerSnapshot {
  time: number;
  playing: boolean;
  speed: number;
  durationMs: number;
  /** Every source as it was at `time`. */
  sources: readonly SourceInfo[];
}

/**
 * Plays a recording into the 3D view: a scene feed whose clock advances with the frames the view draws.
 * React UI subscribes via `usePlayer`.
 */
export class Player implements SceneFeed {
  private clock: PlaybackClock = { time: 0, playing: false, speed: 1 };
  private lastFrame: number | undefined;
  private view: PlaybackView | undefined;
  private listeners = new Set<() => void>();
  private snapshot: PlayerSnapshot;
  private lastNotify = 0;

  constructor(readonly recording: Recording) {
    this.snapshot = this.makeSnapshot();
    void this.recording
      .load(0)
      .then(() => this.refresh())
      .catch((error: unknown) => console.error("Cannot read the recording", error));
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  frame(now = performance.now()): SceneSource[] {
    const elapsed = this.lastFrame === undefined ? 0 : now - this.lastFrame;
    this.lastFrame = now;
    const before = this.clock;
    this.clock = tick(this.clock, elapsed, this.recording.durationMs);
    this.refresh(this.clock.playing === before.playing && now - this.lastNotify < UI_INTERVAL_MS);
    return this.view?.scene ?? [];
  }

  latestState(sourceId: string): StateMessage | undefined {
    return this.view?.latestState(sourceId);
  }

  productEvents(windowMs: number) {
    const now = this.clock.time;
    return { events: this.recording.products.events(now - windowMs, now), now, since: 0 };
  }

  productHistory(sourceId: string, conveyorId: number, productId: number) {
    const now = this.clock.time;
    return { steps: this.recording.products.of(sourceId, conveyorId, productId, now), now };
  }

  /** Pauses, e.g. when the view goes back to live; the clock does not run while nobody draws it. */
  pause(): void {
    this.set({ ...this.clock, playing: false });
  }

  togglePlay(): void {
    this.set(this.clock.playing ? { ...this.clock, playing: false } : playFrom(this.clock, this.recording.durationMs));
  }

  setSpeed(speed: number): void {
    this.set({ ...this.clock, speed });
  }

  seek(time: number): void {
    this.set(seek(this.clock, time, this.recording.durationMs));
  }

  /** Jumps to the next or previous timeline event; stays put if there is none. */
  jumpToEvent(direction: 1 | -1): void {
    const at = eventTime(this.recording.events, this.clock.time, direction);
    if (at !== undefined) this.seek(at);
  }

  step(direction: 1 | -1): void {
    this.set(step(this.clock, this.recording.snapshotTimes, direction));
  }

  private set(clock: PlaybackClock): void {
    this.clock = clock;
    this.lastFrame = undefined;
    this.refresh();
  }

  /**
   * Takes the view at the clock's time; until its blocks are decompressed the previous view stays. `quiet` skips the
   * UI update unless the sources changed (config, status), to keep React renders rare while playing.
   */
  private refresh(quiet = false): void {
    const time = this.clock.time;
    const view = this.recording.view(time);
    if (view) this.view = view;
    else {
      void this.recording
        .load(time)
        .then(() => this.clock.time === time && this.refresh())
        .catch((error: unknown) => console.error("Cannot read the recording", error));
    }
    const sourcesChanged = sourcesKey(this.snapshot.sources) !== sourcesKey(this.view?.sources ?? []);
    if (quiet && !sourcesChanged) return;
    this.snapshot = this.makeSnapshot();
    this.lastNotify = performance.now();
    for (const l of this.listeners) l();
  }

  private makeSnapshot(): PlayerSnapshot {
    const sources = this.view?.sources ?? [];
    const same = sourcesKey(this.snapshot?.sources ?? []) === sourcesKey(sources);
    return {
      ...this.clock,
      durationMs: this.recording.durationMs,
      // Keep the array while nothing changed, so components depending on it do not re-render.
      sources: same && this.snapshot ? this.snapshot.sources : sources,
    };
  }
}

/** Identity of what the UI shows of the sources: names, connection, config versions. */
function sourcesKey(sources: readonly SourceInfo[]): string {
  return sources
    .map(
      (s) =>
        `${s.sourceId}|${s.name}|${s.status?.plcConnected}|${s.status?.lastError}|${s.config?.configVersion}|${s.config?.components.length}`,
    )
    .join(",");
}

const NO_PLAYER: PlayerSnapshot | undefined = undefined;
const noSubscribe = () => () => {};

export function usePlayer(player: Player | undefined): PlayerSnapshot | undefined {
  return useSyncExternalStore(player?.subscribe ?? noSubscribe, player ? player.getSnapshot : () => NO_PLAYER);
}
