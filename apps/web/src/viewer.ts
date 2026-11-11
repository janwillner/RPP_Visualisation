import { useSyncExternalStore } from "react";
import type { StateMessage } from "@rpp/protocol";
import type { MessageListener } from "./gateway-connection";
import type { ProductEvent, ProductStep } from "./product-history";
import { Player } from "./player";
import { MAX_RECORDING_MS, Recorder, Recording, RecordingFileError } from "./recording";
import type { SceneSource } from "./scene/scene-model";
import type { SourceInfo } from "./sources";

/**
 * What the user is looking at: the live machine or a recording being played back, and the recordings behind it
 * (ADR 0006, 0011). One recording at a time: recording live, a finished or opened one, or the replay buffer's last
 * minute. The 3D view and the inspector read whatever is shown through the viewer, a `SceneFeed` itself.
 */

export type ViewMode = "live" | "playback";

/** What the 3D view and the inspector read every frame: the live machine or a recording being played back. */
export interface SceneFeed {
  /** Every source as the machine scene takes it, at `now` (performance.now()); called once per drawn frame, it moves
   * the playback clock on. */
  frame(now?: number): SceneSource[];
  /** A source's newest state, e.g. for the inspector. */
  latestState(sourceId: string): StateMessage | undefined;
  /** What has happened to a product so far, and the current moment on the same clock. */
  productHistory(sourceId: string, conveyorId: number, productId: number): { steps: ProductStep[]; now: number };
  /** Product events of the last `windowMs`, the current moment and when the data starts, for the metrics. */
  productEvents(windowMs: number): { events: ProductEvent[]; now: number; since: number };
}

/** The live machine as the viewer needs it; `LiveMachine` in the app, a fake in tests. */
export interface LiveFeed extends SceneFeed {
  /** Every message from now on, with its arrival time (performance.now()). */
  onMessage(listener: MessageListener): () => void;
  /** Every source as it is now, where a recording starts. */
  recordingContext(): readonly SourceInfo[];
  subscribe(listener: () => void): () => void;
  getSnapshot(): { sources: readonly SourceInfo[] };
}

export interface ViewerSnapshot {
  mode: ViewMode;
  /** The sources shown: live, or the recording's at the playback moment. */
  sources: readonly SourceInfo[];
  /** The recorder while recording live; it stays until its last block is compressed. */
  recorder: Recorder | undefined;
  /** The finished, opened or replayed recording, played by it. */
  player: Player | undefined;
  /** False while a recording exists that was neither saved nor opened from a file. */
  saved: boolean;
  /** Set when the recording stopped by itself (length limit) or something could not be done. */
  notice: string | undefined;
  /** True once the replay buffer holds something to replay. */
  canReplay: boolean;
}

/** A recording as a file to save. */
export interface RecordingFile {
  bytes: Uint8Array;
  name: string;
}

export const LIMIT_NOTICE = `The recording stopped at its limit of ${MAX_RECORDING_MS / 60_000} minutes.`;

export class Viewer implements SceneFeed {
  /** Always keeps the last minute of the live messages, from the viewer's creation (ADR 0011). */
  private readonly replayBuffer = Recorder.replayBuffer();
  private readonly replayOrigin = performance.now();
  private snapshot: ViewerSnapshot;
  private readonly listeners = new Set<() => void>();
  private running: (() => void)[] = [];
  /** Ends the live recording's subscription and limit timer. */
  private endRecording: (() => void) | undefined;
  /** The recorder being stopped: its compression is still finishing. */
  private stopping: Recorder | undefined;
  /** True while the replay buffer's minute is being turned into a recording: nothing else may start meanwhile. */
  private replaying = false;
  private unsubscribePlayer: (() => void) | undefined;

  /** `confirmDiscard` asks whether an unsaved recording may be discarded. */
  constructor(
    private readonly live: LiveFeed,
    private readonly confirmDiscard: () => boolean = () => true,
  ) {
    this.snapshot = {
      mode: "live",
      sources: live.getSnapshot().sources,
      recorder: undefined,
      player: undefined,
      saved: true,
      notice: undefined,
      canReplay: false,
    };
  }

  /** Starts following the live machine: the replay buffer and the shown sources. */
  start(): void {
    if (this.running.length > 0) return;
    this.running = [
      this.live.onMessage((message, raw, arrival) => {
        this.replayBuffer.add(arrival - this.replayOrigin, message, raw);
        if (!this.snapshot.canReplay) this.set({ canReplay: true });
      }),
      this.live.subscribe(() => this.refreshSources()),
    ];
  }

  stop(): void {
    for (const off of this.running) off();
    this.running = [];
    this.endRecording?.();
    this.endRecording = undefined;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  // What is shown, for the 3D view and the inspector.

  frame(now = performance.now()): SceneSource[] {
    return this.feed().frame(now);
  }

  latestState(sourceId: string): StateMessage | undefined {
    return this.feed().latestState(sourceId);
  }

  productHistory(sourceId: string, conveyorId: number, productId: number) {
    return this.feed().productHistory(sourceId, conveyorId, productId);
  }

  productEvents(windowMs: number) {
    return this.feed().productEvents(windowMs);
  }

  // Commands.

  /** Starts recording live; not while a recording is made or replayed, and an unsaved one is discarded first. */
  record(): void {
    if (this.snapshot.recorder || this.replaying || !this.replaceAllowed()) return;
    const active = new Recorder(this.live.recordingContext());
    const started = performance.now();
    const unsubscribe = this.live.onMessage((message, raw, arrival) => {
      if (!active.add(arrival - started, message, raw) && active.full) void this.finish(active, LIMIT_NOTICE);
    });
    // The limit also applies while the gateway sends nothing.
    const timer = setInterval(() => {
      if (performance.now() - started >= MAX_RECORDING_MS) void this.finish(active, LIMIT_NOTICE);
    }, 1000);
    this.endRecording = () => {
      unsubscribe();
      clearInterval(timer);
    };
    this.setPlayer(undefined);
    this.set({ mode: "live", saved: true, notice: undefined, recorder: active });
  }

  /** Stops recording live and plays the recording back. */
  stopRecording(): Promise<void> {
    const active = this.snapshot.recorder;
    return active ? this.finish(active) : Promise.resolve();
  }

  /** Discards the shown recording and goes live, after asking if it is unsaved. */
  discard(): void {
    if (!this.replaceAllowed()) return;
    this.setPlayer(undefined);
    this.set({ mode: "live", saved: true });
  }

  /** Opens a saved recording; `name` is the file's, for the notice when it cannot be read. */
  async open(name: string, read: () => Promise<Uint8Array>): Promise<void> {
    if (this.snapshot.recorder || this.replaying || !this.replaceAllowed()) return;
    try {
      this.show(await Recording.fromFile(await read()), true);
    } catch (error) {
      this.set({ notice: error instanceof RecordingFileError ? error.message : `Cannot open ${name}: ${String(error)}` });
    }
  }

  /** Plays the replay buffer's last minute as a new, unsaved recording. */
  async replay(): Promise<void> {
    if (this.snapshot.recorder || this.replaying || this.replayBuffer.empty || !this.replaceAllowed()) return;
    this.replaying = true;
    try {
      const recording = await this.replayBuffer.snapshot();
      if (recording) this.show(recording, false);
    } catch (error) {
      this.set({ notice: `The last minute could not be replayed: ${String(error)}` });
    } finally {
      this.replaying = false;
    }
  }

  /** The shown recording as a file; it counts as saved from then on. */
  async save(): Promise<RecordingFile | undefined> {
    const player = this.snapshot.player;
    if (!player) return undefined;
    try {
      const bytes = await player.recording.toFile();
      this.set({ saved: true });
      return { bytes, name: fileName(player.recording.recordedAt) };
    } catch (error) {
      this.set({ notice: `The recording could not be saved: ${String(error)}` });
      return undefined;
    }
  }

  /** Back to live pauses, so the playback clock does not count the time spent live. */
  setMode(mode: ViewMode): void {
    if (mode === "live") this.snapshot.player?.pause();
    if (mode === "playback" && !this.snapshot.player) return;
    this.set({ mode });
  }

  dismissNotice(): void {
    this.set({ notice: undefined });
  }

  private feed(): SceneFeed {
    return this.snapshot.mode === "playback" && this.snapshot.player ? this.snapshot.player : this.live;
  }

  private replaceAllowed(): boolean {
    return this.snapshot.saved || !this.snapshot.player || this.confirmDiscard();
  }

  private async finish(active: Recorder, reason?: string): Promise<void> {
    if (this.stopping === active) return;
    this.stopping = active;
    this.endRecording?.();
    this.endRecording = undefined;
    // The recorder stays set until its last block is compressed, so nothing can start in between.
    try {
      this.show(await active.stop(), false, reason);
    } catch (error) {
      this.set({ notice: `The recording could not be finished: ${String(error)}` });
    } finally {
      this.stopping = undefined;
      this.set({ recorder: undefined });
    }
  }

  /** Shows `recording` in playback. */
  private show(recording: Recording, saved: boolean, notice?: string): void {
    this.setPlayer(new Player(recording));
    this.set({ mode: "playback", saved, notice });
  }

  private setPlayer(player: Player | undefined): void {
    this.snapshot.player?.pause();
    this.unsubscribePlayer?.();
    this.unsubscribePlayer = player?.subscribe(() => this.refreshSources());
    this.set({ player });
  }

  /** Takes the shown sources again; a new snapshot only when they changed. */
  private refreshSources(): void {
    this.set({});
  }

  /** Applies `patch` and takes the shown sources for the resulting mode and player. */
  private set(patch: Partial<Omit<ViewerSnapshot, "sources">>): void {
    const next = { ...this.snapshot, ...patch };
    next.sources = next.mode === "playback" && next.player ? next.player.getSnapshot().sources : this.live.getSnapshot().sources;
    if (Object.keys(patch).length === 0 && next.sources === this.snapshot.sources) return;
    this.snapshot = next;
    for (const l of this.listeners) l();
  }
}

function fileName(recordedAt: string): string {
  const d = new Date(recordedAt);
  const two = (n: number) => String(n).padStart(2, "0");
  return `rpp-recording-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}.rpprec`;
}

export function useViewer(viewer: Viewer): ViewerSnapshot {
  return useSyncExternalStore(viewer.subscribe, viewer.getSnapshot);
}
