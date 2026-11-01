import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type ConfigMessage, type GatewayMessage, type StateMessage } from "@rpp/protocol";
import {
  MAX_RECORDING_MS,
  Recorder,
  Recording,
  RecordingFileError,
  eventTime,
  playFrom,
  seek,
  step,
  tick,
  type PlaybackClock,
} from "../src/recording";

const A = "ads:5.1.2.3.1.1:851";
const B = "ads:5.1.2.4.1.1:851";

function config(sourceId: string, configVersion = 1, name = "Infeed"): ConfigMessage {
  return {
    kind: "config",
    sourceId,
    protocolVersion: PROTOCOL_VERSION,
    configVersion,
    errors: [],
    components: [
      {
        type: "conveyor",
        id: 1,
        sourceId,
        name,
        pose: { x: 0, y: 0, z: 800, rx: 0, ry: 0, rz: 0 },
        length: 3000,
        width: 400,
        productTypes: [],
        originShift: { x: 0, y: 0, z: 0 },
      },
    ],
  };
}

function state(sourceId: string, tRel: number, configVersion = 1): StateMessage {
  return {
    kind: "state",
    sourceId,
    configVersion,
    timestamp: String(Math.round(tRel * 1e6)),
    tRel,
    components: [{ type: "conveyor", id: 1, timestamp: "0", beltPosition: tRel / 10, products: [], fault: null }],
  };
}

const status = (sourceId: string, plcConnected: boolean): GatewayMessage => ({
  kind: "status",
  sourceId,
  sourceName: sourceId === A ? "Infeed PLC" : "Outfeed PLC",
  status: { plcConnected },
});

/**
 * Three seconds of two sources, a state every 20 ms each. B's PLC clock runs 5 s ahead of A's, so the same moment
 * has another tRel on each source. `extra` messages are merged in at their time.
 */
async function threeSeconds(extra: [number, GatewayMessage][] = []): Promise<Recording> {
  const recorder = new Recorder([
    { sourceId: A, name: "Infeed PLC", status: { plcConnected: true }, config: config(A) },
    { sourceId: B, name: "Outfeed PLC", status: { plcConnected: true }, config: config(B) },
  ]);
  const messages: [number, GatewayMessage][] = [...extra];
  for (let at = 0; at <= 3000; at += 20) messages.push([at, state(A, at)], [at, state(B, at + 5000)]);
  messages.sort((x, y) => x[0] - y[0]);
  for (const [at, message] of messages) recorder.add(at, message);
  return recorder.stop();
}

const belt = (view: Awaited<ReturnType<Recording["viewAt"]>>, sourceId: string) => {
  const latest = view.latestState(sourceId)?.components[0];
  return latest?.type === "conveyor" ? latest.beltPosition : undefined;
};

describe("recording: playback at any point in time", () => {
  it("gives every source's config, states and render time at the chosen moment, each on its own PLC clock", async () => {
    const recording = await threeSeconds();
    const view = await recording.viewAt(1500);

    expect(recording.durationMs).toBe(3000);
    expect(view.sources.map((s) => [s.sourceId, s.name, s.status?.plcConnected])).toEqual([
      [A, "Infeed PLC", true],
      [B, "Outfeed PLC", true],
    ]);
    const [a, b] = view.scene;
    expect(a!.online).toBe(true);
    // Rendered RENDER_DELAY_MS behind the newest snapshot, like live.
    expect(a!.renderTime).toBeCloseTo(1460);
    expect(b!.renderTime).toBeCloseTo(6460);
    expect(a!.snapshots.at(-1)!.tRel).toBe(1500);
    expect(belt(view, B)).toBe(650);
  });

  it("jumps backwards and forwards", async () => {
    const recording = await threeSeconds();

    expect(belt(await recording.viewAt(2900), A)).toBe(290);
    expect(belt(await recording.viewAt(100), A)).toBe(10);
    expect(belt(await recording.viewAt(3000), A)).toBe(300);
  });

  it("shows the config that was valid at that moment", async () => {
    const recording = await threeSeconds([[2000, config(A, 2, "Infeed renamed")]]);

    const before = await recording.viewAt(1000);
    const after = await recording.viewAt(2500);
    expect(before.sources[0]!.config!.components[0]!.name).toBe("Infeed");
    expect(after.sources[0]!.config!.components[0]!.name).toBe("Infeed renamed");
    // States of the old config version do not belong to the new one.
    expect(after.scene[0]!.snapshots).toEqual([]);
  });

  it("shows a source offline while it was not connected", async () => {
    const recording = await threeSeconds([[1000, status(B, false)]]);

    expect((await recording.viewAt(900)).scene.map((s) => s.online)).toEqual([true, true]);
    expect((await recording.viewAt(1500)).scene.map((s) => s.online)).toEqual([true, false]);
  });

  it("plays back product registers that change over time, in their order", async () => {
    const product = (id: number, state: "detected" | "picked") => ({
      id,
      latchPose: { x: 100, y: 0, z: 800, rz: 0 },
      latchBeltPosition: 0,
      state,
      robotId: state === "picked" ? 10 : 0,
      moverId: 0,
      fingerId: 0,
      productType: 1,
    });
    const register = (at: number, products: ReturnType<typeof product>[]): StateMessage => ({
      ...state(A, at),
      components: [{ type: "conveyor", id: 1, timestamp: "0", beltPosition: at, products, fault: null }],
    });
    const recorder = new Recorder([{ sourceId: A, name: "Infeed PLC", status: { plcConnected: true }, config: config(A) }]);
    const timeline: [number, ReturnType<typeof product>[]][] = [
      [0, [product(1, "detected"), product(2, "detected")]],
      [500, [product(1, "detected"), product(2, "detected")]],
      [900, [product(1, "picked"), product(2, "detected")]],
      [1100, [product(2, "detected"), product(3, "detected"), product(1, "picked")]],
      [1600, [product(3, "detected")]],
    ];
    for (const [at, products] of timeline) recorder.add(at, register(at, products));
    const recording = await recorder.stop();

    for (const opened of [recording, await Recording.fromFile(await recording.toFile())]) {
      for (const [at, products] of timeline) {
        const latest = (await opened.viewAt(at)).latestState(A)!.components[0]!;
        expect(latest.type === "conveyor" && latest.products).toEqual(products);
      }
    }
  });

  it("keeps the last state of a source that stopped sending, like live", async () => {
    const recorder = new Recorder([
      { sourceId: A, name: "Infeed PLC", status: { plcConnected: true }, config: config(A) },
      { sourceId: B, name: "Outfeed PLC", status: { plcConnected: true }, config: config(B) },
    ]);
    for (let at = 0; at <= 5000; at += 20) {
      recorder.add(at, state(A, at));
      if (at <= 1000) recorder.add(at, state(B, at));
      if (at === 1020) recorder.add(at, status(B, false));
    }
    const recording = await recorder.stop();

    const view = await recording.viewAt(4500);
    expect(view.scene[1]!.online).toBe(false);
    expect(belt(view, B)).toBe(100);
    expect(view.scene[1]!.snapshots.at(-1)!.tRel).toBe(1000);
  });

  it("gives the moment of every snapshot, for stepping", async () => {
    const recording = await threeSeconds();

    expect(recording.snapshotTimes.slice(0, 3)).toEqual([0, 20, 40]);
    expect(recording.snapshotTimes.at(-1)).toBe(3000);
  });
});

describe("recording: timeline events", () => {
  it("marks where a source went offline and where it came back", async () => {
    const recording = await threeSeconds([
      [1000, status(B, false)],
      [1200, status(B, false)],
      [2000, status(B, true)],
    ]);
    expect(recording.events).toEqual([
      { at: 1000, kind: "offline", sourceId: B, text: "Outfeed PLC offline" },
      { at: 2000, kind: "online", sourceId: B, text: "Outfeed PLC online" },
    ]);
  });

  it("marks where a fault appears, once while it lasts, for components and XTS movers", async () => {
    const recorder = new Recorder([{ sourceId: A, name: "Infeed PLC", status: { plcConnected: true }, config: config(A) }]);
    const jam = { message: "Belt jammed" };
    for (let at = 0; at <= 3000; at += 100) {
      const beltFault = (at >= 1000 && at < 1500) || at >= 2000 ? jam : null;
      const moverFault = at >= 2500 ? { message: "Collision" } : null;
      recorder.add(at, {
        ...state(A, at),
        components: [
          { type: "conveyor", id: 1, timestamp: "0", beltPosition: 0, products: [], fault: beltFault },
          // Not in the config: named by its id.
          { type: "xtsLoop", id: 7, timestamp: "0", movers: [{ id: 2, position: 0, fingers: [], fault: moverFault }], fault: null },
        ],
      });
    }
    expect((await recorder.stop()).events).toEqual([
      { at: 1000, kind: "fault", sourceId: A, text: "Infeed: Belt jammed" },
      { at: 2000, kind: "fault", sourceId: A, text: "Infeed: Belt jammed" },
      { at: 2500, kind: "fault", sourceId: A, text: "#7 mover 2: Collision" },
    ]);
  });

  it("marks a fault again when its source comes back with it still active", async () => {
    const recorder = new Recorder([{ sourceId: A, name: "Infeed PLC", status: { plcConnected: true }, config: config(A) }]);
    const faulted = (at: number): StateMessage => ({
      ...state(A, at),
      components: [{ type: "conveyor", id: 1, timestamp: "0", beltPosition: 0, products: [], fault: { message: "Belt jammed" } }],
    });
    for (let at = 0; at < 1000; at += 100) recorder.add(at, faulted(at));
    recorder.add(1000, status(A, false));
    recorder.add(2000, status(A, true));
    for (let at = 2000; at <= 2500; at += 100) recorder.add(at, faulted(at));

    expect((await recorder.stop()).events.map((e) => [e.at, e.kind])).toEqual([
      [0, "fault"],
      [1000, "offline"],
      [2000, "online"],
      [2000, "fault"],
    ]);
  });

  it("marks a product that passes the belt end without being picked, once", async () => {
    const product = (id: number, productState: "detected" | "rejected" | "picked") => ({
      id,
      latchPose: { x: 100, y: 0, z: 800, rz: 0 },
      latchBeltPosition: 0,
      state: productState,
      robotId: productState === "picked" ? 10 : 0,
      moverId: 0,
      fingerId: 0,
      productType: 1,
    });
    const recorder = new Recorder([{ sourceId: A, name: "Infeed PLC", status: { plcConnected: true }, config: config(A) }]);
    // The belt is 3000 mm long and moves 1 mm per ms: a product latched at x = 100 passes the end after 2900 ms.
    for (let at = 0; at <= 3500; at += 100) {
      const products = [product(1, "detected"), product(2, "rejected"), product(3, "picked")];
      recorder.add(at, {
        ...state(A, at),
        components: [{ type: "conveyor", id: 1, timestamp: "0", beltPosition: at, products, fault: null }],
      });
    }
    expect((await recorder.stop()).events).toEqual([
      { at: 3000, kind: "missed", sourceId: A, text: "Infeed: product #1 missed" },
    ]);
  });

  it("keeps its events in the file", async () => {
    const recording = await threeSeconds([
      [1000, status(B, false)],
      [2000, status(B, true)],
    ]);
    expect((await Recording.fromFile(await recording.toFile())).events).toEqual(recording.events);
  });

  it("jumps to the next or previous event", () => {
    const events = [1000, 2000, 3000].map((at) => ({ at, kind: "fault" as const, sourceId: A, text: "" }));
    expect(eventTime(events, 1500, 1)).toBe(2000);
    expect(eventTime(events, 2000, 1)).toBe(3000);
    expect(eventTime(events, 2000, -1)).toBe(1000);
    expect(eventTime(events, 3000, 1)).toBeUndefined();
    expect(eventTime(events, 1000, -1)).toBeUndefined();
  });
});

describe("recording: limits and files", () => {
  it("takes nothing after 10 minutes", async () => {
    const recorder = new Recorder([]);
    expect(recorder.add(0, state(A, 0))).toBe(true);
    expect(recorder.add(MAX_RECORDING_MS - 20, state(A, MAX_RECORDING_MS - 20))).toBe(true);
    expect(recorder.add(MAX_RECORDING_MS, state(A, MAX_RECORDING_MS))).toBe(false);
    expect(recorder.full).toBe(true);

    expect((await recorder.stop()).durationMs).toBe(MAX_RECORDING_MS - 20);
  });

  it("saves to a file and opens it again with the same playback", async () => {
    const recording = await threeSeconds([
      [1000, status(B, false)],
      [2000, config(A, 2, "Infeed renamed")],
    ]);

    const opened = await Recording.fromFile(await recording.toFile());

    expect(opened.durationMs).toBe(recording.durationMs);
    expect(opened.recordedAt).toBe(recording.recordedAt);
    for (const t of [0, 990, 1500, 2600, 3000]) {
      const [x, y] = [await recording.viewAt(t), await opened.viewAt(t)];
      expect(y.sources).toEqual(x.sources);
      expect(y.scene).toEqual(x.scene);
    }
  });

  it("refuses a file of another protocol version, naming both versions", async () => {
    const recording = await threeSeconds();
    const text = new TextDecoder().decode(await gunzip(await recording.toFile()));
    const other = text.replace(`"protocolVersion":${PROTOCOL_VERSION}`, `"protocolVersion":${PROTOCOL_VERSION - 1}`);

    await expect(Recording.fromFile(await gzip(other))).rejects.toThrow(RecordingFileError);
    await expect(Recording.fromFile(await gzip(other))).rejects.toThrow(
      `protocol version ${PROTOCOL_VERSION - 1}, this version plays ${PROTOCOL_VERSION}`,
    );
  });

  it("refuses a file that is no recording", async () => {
    await expect(Recording.fromFile(await gzip('{"hello":1}\n'))).rejects.toThrow(RecordingFileError);
    await expect(Recording.fromFile(new TextEncoder().encode("plain text"))).rejects.toThrow(RecordingFileError);
  });
});

describe("playback clock", () => {
  const paused: PlaybackClock = { time: 0, playing: false, speed: 1 };

  it("advances by the elapsed time times the speed while playing", () => {
    expect(tick({ time: 100, playing: true, speed: 0.25 }, 1000, 3000)).toEqual({ time: 350, playing: true, speed: 0.25 });
    expect(tick({ time: 100, playing: false, speed: 1 }, 1000, 3000).time).toBe(100);
  });

  it("stops at the end", () => {
    expect(tick({ time: 2900, playing: true, speed: 2 }, 100, 3000)).toEqual({ time: 3000, playing: false, speed: 2 });
  });

  it("starts again from the beginning when played at the end", () => {
    expect(playFrom({ ...paused, time: 3000 }, 3000)).toMatchObject({ time: 0, playing: true });
    expect(playFrom({ ...paused, time: 1200 }, 3000)).toMatchObject({ time: 1200, playing: true });
  });

  it("jumps to a moment within the recording", () => {
    expect(seek(paused, 1234, 3000).time).toBe(1234);
    expect(seek(paused, 5000, 3000).time).toBe(3000);
    expect(seek(paused, -5, 3000).time).toBe(0);
  });

  it("steps to the next or previous snapshot and pauses", () => {
    const times = [0, 20, 40, 60];
    expect(step({ time: 25, playing: true, speed: 1 }, times, 1)).toEqual({ time: 40, playing: false, speed: 1 });
    expect(step({ ...paused, time: 25 }, times, -1).time).toBe(20);
    expect(step({ ...paused, time: 20 }, times, -1).time).toBe(0);
    expect(step({ ...paused, time: 60 }, times, 1).time).toBe(60);
    expect(step({ ...paused, time: 0 }, times, -1).time).toBe(0);
  });
});

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
