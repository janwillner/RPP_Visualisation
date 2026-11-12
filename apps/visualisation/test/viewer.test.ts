import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type GatewayMessage } from "@rpp/protocol";
import { type MessageListener, type SourceInfo, Sources } from "@rpp/machine-view";
import { MAX_RECORDING_MS } from "../src/recording";
import { LIMIT_NOTICE, Viewer, type LiveFeed, type ViewerSnapshot } from "../src/viewer";

const A = "ads:5.1.2.3.1.1:851";

/** The live machine: messages sent here reach the viewer like the gateway's. */
class FakeLive implements LiveFeed {
  private readonly sources = new Sources();
  private readonly messageListeners = new Set<MessageListener>();
  private readonly listeners = new Set<() => void>();
  private snapshot = { sources: this.sources.all };

  send(message: GatewayMessage): void {
    const arrival = performance.now();
    const source = this.sources.apply(arrival, message);
    if (this.snapshot.sources !== this.sources.all) {
      this.snapshot = { sources: this.sources.all };
      for (const l of this.listeners) l();
    }
    for (const l of this.messageListeners) l(message, JSON.stringify(message), arrival, source);
  }

  /** A connected source with one config, then a state every 20 ms for `ms`. */
  run(ms: number): void {
    if (this.sources.all.length === 0) {
      this.send({ kind: "status", sourceId: A, sourceName: "Infeed PLC", status: { plcConnected: true } });
      this.send({ kind: "config", sourceId: A, protocolVersion: PROTOCOL_VERSION, configVersion: 1, errors: [], components: [] });
    }
    for (let t = 0; t < ms; t += 20) {
      vi.advanceTimersByTime(20);
      const tRel = performance.now();
      this.send({ kind: "state", sourceId: A, configVersion: 1, timestamp: "0", tRel, components: [] });
    }
  }

  onMessage(listener: MessageListener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }
  recordingContext = (): readonly SourceInfo[] => this.sources.all;
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getSnapshot = () => this.snapshot;
  frame = (now = performance.now()) => this.sources.sceneSources(now);
  latestState = (sourceId: string) => this.sources.latestState(sourceId);
  productHistory = () => ({ steps: [], now: performance.now() });
  productEvents = () => ({ events: [], now: performance.now(), since: 0 });
}

/** Resolves once the viewer's snapshot satisfies `test`. */
function until(viewer: Viewer, test: (s: ViewerSnapshot) => boolean): Promise<ViewerSnapshot> {
  return new Promise((resolve) => {
    const check = () => {
      if (!test(viewer.getSnapshot())) return false;
      off();
      resolve(viewer.getSnapshot());
      return true;
    };
    const off = viewer.subscribe(check);
    check();
  });
}

let live: FakeLive;
let confirm: ReturnType<typeof vi.fn<() => boolean>>;
let viewer: Viewer;

beforeEach(() => {
  // Not the timers that streams (compression) need.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
  live = new FakeLive();
  confirm = vi.fn(() => true);
  viewer = new Viewer(live, confirm);
  viewer.start();
});

afterEach(() => {
  viewer.stop();
  vi.useRealTimers();
});

/** Records `ms` of the live machine and plays the recording back. */
async function recorded(ms = 500): Promise<ViewerSnapshot> {
  viewer.record();
  live.run(ms);
  await viewer.stopRecording();
  return viewer.getSnapshot();
}

describe("viewer: live, recordings and playback", () => {
  it("shows the live machine through itself until something is played back", () => {
    live.run(200);

    const view = viewer.getSnapshot();
    expect(view.mode).toBe("live");
    expect(view.sources.map((s) => s.name)).toEqual(["Infeed PLC"]);
    expect(viewer.frame().map((s) => s.snapshots.length)).toEqual([10]);
    expect(viewer.latestState(A)).toBe(live.latestState(A));
  });

  it("plays a stopped recording back, unsaved, with the sources it recorded", async () => {
    live.run(100);
    const view = await recorded(500);

    expect(view).toMatchObject({ mode: "playback", recorder: undefined, saved: false });
    expect(view.player?.recording.durationMs).toBeGreaterThan(400);
    const shown = await until(viewer, (s) => s.sources.length === 1);
    expect(shown.sources).not.toBe(live.getSnapshot().sources);
    expect(shown.sources[0]!.name).toBe("Infeed PLC");
  });

  it("stops a recording at its limit, also while the gateway sends nothing", async () => {
    viewer.record();
    live.run(100);
    vi.advanceTimersByTime(MAX_RECORDING_MS);

    const view = await until(viewer, (s) => s.player !== undefined && s.recorder === undefined);
    expect(view.mode).toBe("playback");
    expect(view.notice).toBe(LIMIT_NOTICE);
  });

  it("asks before an unsaved recording is replaced, and keeps it on no", async () => {
    const first = (await recorded()).player;
    confirm.mockReturnValue(false);

    viewer.record();
    viewer.discard();
    expect(viewer.getSnapshot()).toMatchObject({ mode: "playback", recorder: undefined, player: first });
    expect(confirm).toHaveBeenCalledTimes(2);

    confirm.mockReturnValue(true);
    viewer.record();
    expect(viewer.getSnapshot()).toMatchObject({ mode: "live", player: undefined, saved: true });
    expect(viewer.getSnapshot().recorder).toBeDefined();
  });

  it("does not ask once the recording is saved, and gives it as a file", async () => {
    await recorded();

    const file = await viewer.save();
    expect(file?.name).toMatch(/^rpp-recording-\d{8}-\d{6}\.rpprec$/);
    expect(file!.bytes.length).toBeGreaterThan(0);
    expect(viewer.getSnapshot().saved).toBe(true);
    viewer.discard();
    expect(confirm).not.toHaveBeenCalled();
    expect(viewer.getSnapshot()).toMatchObject({ mode: "live", player: undefined });
  });

  it("opens a saved recording, saved, and tells when a file is none", async () => {
    await recorded();
    const file = (await viewer.save())!;
    viewer.discard();

    await viewer.open(file.name, async () => file.bytes);
    expect(viewer.getSnapshot()).toMatchObject({ mode: "playback", saved: true });

    await viewer.open("notes.txt", async () => new TextEncoder().encode("hello"));
    expect(viewer.getSnapshot().notice).toMatch(/not a recording file/);
  });

  it("replays the last minute of the live machine as a new, unsaved recording", async () => {
    expect(viewer.getSnapshot().canReplay).toBe(false);
    live.run(2000);
    expect(viewer.getSnapshot().canReplay).toBe(true);

    await viewer.replay();
    const view = viewer.getSnapshot();
    expect(view).toMatchObject({ mode: "playback", saved: false });
    expect(view.player!.recording.durationMs).toBeGreaterThan(1900);
  });

  it("neither replays nor opens a file while recording", async () => {
    live.run(200);
    viewer.record();
    const read = vi.fn(async () => new Uint8Array());

    await viewer.replay();
    await viewer.open("x.rpprec", read);
    expect(viewer.getSnapshot()).toMatchObject({ mode: "live", player: undefined });
    expect(read).not.toHaveBeenCalled();
  });

  it("pauses playback when going live and shows the live machine again", async () => {
    await recorded();
    const player = viewer.getSnapshot().player!;
    player.togglePlay();
    expect(player.getSnapshot().playing).toBe(true);

    viewer.setMode("live");
    expect(player.getSnapshot().playing).toBe(false);
    expect(viewer.getSnapshot().sources).toBe(live.getSnapshot().sources);
    expect(viewer.latestState(A)).toBe(live.latestState(A));

    viewer.setMode("playback");
    expect(viewer.getSnapshot().mode).toBe("playback");
  });
});
