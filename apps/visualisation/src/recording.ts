import {
  PROTOCOL_VERSION,
  RECORDING_FILE_FORMAT,
  RECORDING_FILE_FORMAT_VERSION,
  RegisterDecoder,
  RegisterEncoder,
  type ConfigMessage,
  type GatewayMessage,
  type RecordingEntry,
  type RecordingFileHeader,
  type StateMessage,
} from "@rpp/protocol";
import { ProductHistory, type SceneSource, type SourceInfo, Sources } from "@rpp/machine-view";
import { EventTracker, type TimelineEvent } from "./timeline-events";

export { eventTime, type TimelineEvent, type TimelineEventKind } from "./timeline-events";

/**
 * Recording and playback of what the gateway sends, kept in the browser (ADR 0006). The recorder stores every
 * message with its arrival time, gzip-compressed in blocks of CHUNK_MS; a recording answers, for any moment, what
 * every source looked like then, in the shape the machine scene takes.
 */

/** A recording stops taking messages at this length. */
export const MAX_RECORDING_MS = 10 * 60_000;
/** What the replay buffer keeps, back from its newest message (ADR 0011). */
export const REPLAY_BUFFER_MS = 60_000;
/** Messages are compressed in blocks of this length. */
const CHUNK_MS = 1000;
/** Blocks back from the playback moment that are read for the states kept for interpolation (`Sources`). */
const WINDOW_MS = 1000;
/** Decompressed blocks kept for playback. */
const CACHED_CHUNKS = 6;

/** A gateway message and when it arrived, ms after the recording started. */
interface Entry {
  at: number;
  message: GatewayMessage;
}

/**
 * An entry as stored (`RecordingEntry`, documented at /docs). A conveyor's product register hardly changes from one
 * snapshot to the next but makes up most of a state, and a state is larger than gzip's window: so a stored state holds
 * only the products that changed since the source's previous state, and `registers` lists per conveyor id the ids of
 * the whole register in order.
 */
type StoredEntry = RecordingEntry;

/** The entry to store for `message`; `encoder` holds the registers of the previous states and is updated. */
function storedEntry(at: number, message: GatewayMessage, raw: string, encoder: RegisterEncoder): string {
  if (message.kind !== "state") return `{"at":${at},"message":${raw}}`;
  const { registers: order, ...changed } = encoder.encode(message);
  return JSON.stringify({ at, message: changed, registers: order });
}

/** Restores stored entries in order; `decoder` holds the products of each source's previous state. */
function restoredEntry(stored: StoredEntry, decoder: RegisterDecoder): Entry {
  const { at, message, registers: order } = stored;
  if (message.kind !== "state" || !order) return { at, message };
  return { at, message: decoder.decode({ ...message, registers: order }) };
}

interface Chunk {
  start: number;
  end: number;
  /** Every source as it was when the block starts. */
  context: SourceInfo[];
  /** Sources with at least one state in the block. */
  stateSources: string[];
  data: Uint8Array;
}

/** The first line of a recording file (`RecordingFileHeader`, documented at /docs). */
type FileHeader = RecordingFileHeader;

export class RecordingFileError extends Error {}

/**
 * Takes the gateway's messages while recording. With `windowMs` it is the replay buffer instead: it runs without
 * limit, keeps only the blocks of the last `windowMs` before its newest message and gives them as a recording with
 * `snapshot()` (ADR 0011).
 */
export class Recorder {
  readonly recordedAt: string;
  /** True once MAX_RECORDING_MS is reached; the recorder then takes nothing more. */
  full = false;
  private readonly initial: SourceInfo[];
  private readonly sources: Sources;
  private readonly chunks: Promise<Chunk>[] = [];
  /** Start of every block in `chunks`, known before its compression finishes. */
  private readonly chunkStarts: number[] = [];
  private pending: string[] = [];
  private pendingStart = 0;
  private pendingEnd = 0;
  private pendingContext: SourceInfo[] = [];
  private compressedBytes = 0;
  private pendingBytes = 0;
  private lastAt = 0;
  private stopped = false;
  private readonly snapshotTimes: number[] = [];
  /** The product registers of the block being filled; every block starts with whole registers. */
  private encoder = new RegisterEncoder();
  private pendingStateSources = new Set<string>();
  private readonly tracker: EventTracker;
  /** Every product of the whole recording: it is limited in time, not in products. */
  private readonly products = new ProductHistory(Infinity);

  /** `initial`: every source as it is when recording starts (status and config, if any). */
  constructor(
    initial: readonly SourceInfo[],
    recordedAt = new Date().toISOString(),
    private readonly windowMs?: number,
  ) {
    this.recordedAt = recordedAt;
    this.initial = initial.map((s) => ({ ...s }));
    this.sources = new Sources(this.initial);
    this.tracker = new EventTracker(this.initial);
  }

  /** The replay buffer: keeps the last REPLAY_BUFFER_MS, from now on. */
  static replayBuffer(): Recorder {
    return new Recorder([], undefined, REPLAY_BUFFER_MS);
  }

  /** True while the recorder holds no message. */
  get empty(): boolean {
    return this.chunks.length === 0 && this.pending.length === 0;
  }

  /** Length so far, ms. */
  get durationMs(): number {
    return this.lastAt;
  }

  /** Memory taken so far: compressed blocks plus the block being filled. */
  get bytes(): number {
    return this.compressedBytes + this.pendingBytes;
  }

  /**
   * Adds a message that arrived `at` ms after the recording started; `raw` is its JSON as received. Returns false,
   * and keeps nothing, once the recording is full or stopped.
   */
  add(at: number, message: GatewayMessage, raw: string = JSON.stringify(message)): boolean {
    if (this.stopped || this.full) return false;
    if (this.windowMs === undefined && at >= MAX_RECORDING_MS) {
      this.full = true;
      return false;
    }
    if (this.pending.length > 0 && at >= this.pendingStart + CHUNK_MS) this.seal();
    if (this.pending.length === 0) {
      this.pendingStart = at;
      this.pendingContext = [...this.sources.all];
      this.encoder = new RegisterEncoder();
      this.pendingStateSources = new Set();
    }
    if (message.kind === "state") this.pendingStateSources.add(message.sourceId);
    const line = storedEntry(at, message, raw, this.encoder);
    this.pending.push(line);
    this.pendingBytes += line.length;
    this.pendingEnd = at;
    this.lastAt = at;
    const source = this.sources.apply(at, message);
    if (this.windowMs !== undefined) {
      // Events, products and snapshot times are found again from the kept blocks by `snapshot()`.
      this.dropBefore(at - this.windowMs);
      return true;
    }
    if (message.kind === "state" && this.snapshotTimes.at(-1) !== at) this.snapshotTimes.push(at);
    this.tracker.add(at, message, source);
    this.products.add(at, message, source);
    return true;
  }

  /** Ends the recording. */
  async stop(): Promise<Recording> {
    if (this.pending.length > 0) this.seal();
    this.stopped = true;
    const chunks = await Promise.all(this.chunks);
    return new Recording(this.initial, chunks, this.lastAt, this.recordedAt, this.snapshotTimes, this.tracker.events, this.products);
  }

  /**
   * The kept blocks, with the block being filled, as a recording of their own that starts at 0; undefined while the
   * recorder holds nothing. The recorder goes on taking messages.
   */
  async snapshot(): Promise<Recording | undefined> {
    if (this.pending.length > 0) this.seal();
    const chunks = await Promise.all(this.chunks);
    const first = chunks[0];
    if (!first) return undefined;
    const copy = new Recorder(first.context, new Date(Date.parse(this.recordedAt) + first.start).toISOString());
    for (const chunk of chunks) {
      // Every block starts complete.
      const decoder = new RegisterDecoder();
      for (const line of (await gunzipText(chunk.data)).split("\n")) {
        const { at, message } = restoredEntry(JSON.parse(line) as StoredEntry, decoder);
        copy.add(at - first.start, message);
      }
    }
    return copy.stop();
  }

  /** Drops the sealed blocks that start before `time`. */
  private dropBefore(time: number): void {
    while (this.chunkStarts.length > 0 && this.chunkStarts[0]! < time) {
      this.chunkStarts.shift();
      void this.chunks.shift()!.then((chunk) => (this.compressedBytes -= chunk.data.length));
    }
  }

  private seal(): void {
    const text = this.pending.join("\n");
    const block = {
      start: this.pendingStart,
      end: this.pendingEnd,
      context: this.pendingContext,
      stateSources: [...this.pendingStateSources],
    };
    this.pending = [];
    this.pendingBytes = 0;
    this.chunkStarts.push(block.start);
    this.chunks.push(
      gzip(text).then((data) => {
        this.compressedBytes += data.length;
        return { ...block, data };
      }),
    );
  }
}

/** What playback shows at one moment. */
export interface PlaybackView {
  /** Every source with the status and config it had then. */
  sources: readonly SourceInfo[];
  /** Every source as the machine scene takes it. */
  scene: SceneSource[];
  /** A source's newest state at that moment, e.g. for the inspector. */
  latestState(sourceId: string): StateMessage | undefined;
}

/** A finished recording. */
export class Recording {
  private readonly decoded = new Map<number, Promise<Entry[]>>();
  private readonly ready = new Map<number, Entry[]>();

  constructor(
    private readonly initial: readonly SourceInfo[],
    private readonly chunks: readonly Chunk[],
    readonly durationMs: number,
    readonly recordedAt: string,
    /** Moment of every state snapshot, ms, in order: where stepping stops. */
    readonly snapshotTimes: readonly number[],
    /** Faults, sources going offline and back, missed products, in order; found again when a file is opened. */
    readonly events: readonly TimelineEvent[],
    /** What happened to every product, for the inspector at the playback moment. */
    readonly products: ProductHistory,
  ) {}

  /** Decompresses what the given moment needs; afterwards `view(t)` answers without waiting. */
  async load(t: number): Promise<void> {
    const { first, last, earlier } = this.range(t);
    const loads: Promise<Entry[]>[] = [];
    for (let i = Math.max(first, 0); i <= last; i++) loads.push(this.decode(i));
    for (const i of earlier.values()) loads.push(this.decode(i));
    await Promise.all(loads);
  }

  /** What playback shows at `t` ms, or undefined while the blocks it needs are not decompressed yet. */
  view(t: number): PlaybackView | undefined {
    const { first, last, earlier } = this.range(t);
    const blocks: Entry[][] = [];
    for (let i = Math.max(first, 0); i <= last; i++) {
      const entries = this.ready.get(i);
      if (!entries) return undefined;
      blocks.push(entries);
    }
    // A source that stopped sending keeps its last state, as live.
    const lastStates = new Map<string, Entry>();
    for (const [sourceId, i] of earlier) {
      const entries = this.ready.get(i);
      if (!entries) return undefined;
      const last = [...entries].reverse().find((e) => e.message.kind === "state" && e.message.sourceId === sourceId);
      if (last) lastStates.set(sourceId, last);
    }
    return buildView(first >= 0 ? this.chunks[first]!.context : this.initial, lastStates, blocks, t);
  }

  /** `view(t)`, decompressing first if needed. */
  async viewAt(t: number): Promise<PlaybackView> {
    await this.load(t);
    return this.view(t)!;
  }

  /** The recording as a file: one gzip-compressed JSON line per message, after a header line. */
  async toFile(): Promise<Uint8Array> {
    const header: FileHeader = {
      format: RECORDING_FILE_FORMAT,
      formatVersion: RECORDING_FILE_FORMAT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      recordedAt: this.recordedAt,
      durationMs: this.durationMs,
      sources: [...this.initial],
    };
    const encoder = new TextEncoder();
    const chunks = this.chunks;
    const lines = new ReadableStream<Uint8Array<ArrayBuffer>>({
      async start(controller) {
        controller.enqueue(encoder.encode(`${JSON.stringify(header)}\n`));
        // One block at a time, so the whole recording is never decompressed at once.
        for (const chunk of chunks) controller.enqueue(encoder.encode(`${await gunzipText(chunk.data)}\n`));
        controller.close();
      },
    });
    return new Uint8Array(await new Response(lines.pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  }

  /** Opens a file written by `toFile`. Throws RecordingFileError for anything else. */
  static async fromFile(bytes: Uint8Array): Promise<Recording> {
    let recorder: Recorder | undefined;
    const decoder = new RegisterDecoder();
    try {
      const text = new Blob([bytes as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream("gzip"))
        .pipeThrough(new TextDecoderStream());
      for await (const line of lines(text)) {
        if (!line) continue;
        if (!recorder) {
          recorder = new Recorder(...checkedHeader(line));
          continue;
        }
        const { at, message } = restoredEntry(JSON.parse(line) as StoredEntry, decoder);
        recorder.add(at, message);
      }
    } catch (error) {
      if (error instanceof RecordingFileError) throw error;
      throw new RecordingFileError(`This is not a recording file (${(error as Error).message})`);
    }
    if (!recorder) throw new RecordingFileError("The recording file is empty");
    return recorder.stop();
  }

  /**
   * Blocks needed at `t`: from the one holding the oldest snapshot kept to the last one starting before `t`, and per
   * source without a state in those the earlier block holding its last one.
   */
  private range(t: number): { first: number; last: number; earlier: Map<string, number> } {
    let last = -1;
    while (last + 1 < this.chunks.length && this.chunks[last + 1]!.start <= t) last++;
    let first = last;
    while (first > 0 && this.chunks[first - 1]!.end >= t - WINDOW_MS) first--;
    const covered = new Set<string>();
    for (let i = Math.max(first, 0); i <= last; i++) for (const id of this.chunks[i]!.stateSources) covered.add(id);
    const earlier = new Map<string, number>();
    for (let i = first - 1; i >= 0; i--) {
      for (const id of this.chunks[i]!.stateSources) {
        if (!covered.has(id) && !earlier.has(id)) earlier.set(id, i);
      }
    }
    return { first, last, earlier };
  }

  private decode(index: number): Promise<Entry[]> {
    let decoded = this.decoded.get(index);
    if (decoded) {
      // Most recently used last.
      this.decoded.delete(index);
      this.decoded.set(index, decoded);
      return decoded;
    }
    const pending = gunzipText(this.chunks[index]!.data).then((text) => {
      const decoder = new RegisterDecoder();
      const entries = text.split("\n").map((line) => restoredEntry(JSON.parse(line) as StoredEntry, decoder));
      // Not when the block was dropped from the cache meanwhile.
      if (this.decoded.get(index) === pending) this.ready.set(index, entries);
      return entries;
    });
    decoded = pending;
    this.decoded.set(index, decoded);
    // Keep only the most recently used blocks.
    while (this.decoded.size > CACHED_CHUNKS) {
      const oldest = this.decoded.keys().next().value!;
      this.decoded.delete(oldest);
      this.ready.delete(oldest);
    }
    return decoded;
  }
}

/**
 * Applies the blocks up to `t` on top of the sources as they were at the first block's start; `lastStates` are the
 * states of sources that sent none since.
 */
function buildView(
  context: readonly SourceInfo[],
  lastStates: ReadonlyMap<string, Entry>,
  blocks: Entry[][],
  t: number,
): PlaybackView {
  const sources = new Sources(context);
  for (const entry of lastStates.values()) sources.apply(entry.at, entry.message);
  for (const block of blocks) {
    for (const entry of block) {
      if (entry.at > t) break;
      sources.apply(entry.at, entry.message);
    }
  }
  return {
    sources: sources.all,
    scene: sources.sceneSources(t),
    latestState: (sourceId) => sources.latestState(sourceId),
  };
}

/**
 * Protocol versions whose recordings this version plays: its own; 21, which differs only by having no machine reports
 * (a source without one has no machine); and 20, which has no product marks either (a product without a mark plays
 * unmarked, `productMark`; a config without marks names none).
 */
const PLAYABLE_PROTOCOL_VERSIONS: ReadonlySet<number> = new Set([20, 21, PROTOCOL_VERSION]);

function checkedHeader(line: string): [SourceInfo[], string] {
  let header: Partial<FileHeader>;
  try {
    header = JSON.parse(line) as Partial<FileHeader>;
  } catch {
    throw new RecordingFileError("This is not a recording file");
  }
  if (header.format !== RECORDING_FILE_FORMAT || !Array.isArray(header.sources) || typeof header.recordedAt !== "string") {
    throw new RecordingFileError("This is not a recording file");
  }
  if (header.formatVersion !== RECORDING_FILE_FORMAT_VERSION) {
    throw new RecordingFileError(
      `The recording has file format ${header.formatVersion}, this version reads ${RECORDING_FILE_FORMAT_VERSION}`,
    );
  }
  if (!PLAYABLE_PROTOCOL_VERSIONS.has(header.protocolVersion ?? 0)) {
    throw new RecordingFileError(
      `The recording has protocol version ${header.protocolVersion}, this version plays ${PROTOCOL_VERSION}`,
    );
  }
  // JSON leaves out a missing status or config; SourceInfo spells them out.
  const sources = header.sources.map((s): SourceInfo => ({ ...s, status: s.status, config: s.config }));
  return [sources, header.recordedAt];
}

async function* lines(text: ReadableStream<string>): AsyncGenerator<string> {
  let rest = "";
  const reader = text.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const parts = (rest + value).split("\n");
    rest = parts.pop()!;
    yield* parts;
  }
  if (rest) yield rest;
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipText(bytes: Uint8Array): Promise<string> {
  return new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

// ---------------------------------------------------------------------------------------------------------------
// Playback clock

/** Playback speeds offered. */
export const SPEEDS = [0.1, 0.25, 0.5, 1, 2] as const;

export interface PlaybackClock {
  /** ms since the recording started. */
  time: number;
  playing: boolean;
  speed: number;
}

/** The clock after `elapsedMs` of real time; playing stops at the end. */
export function tick(clock: PlaybackClock, elapsedMs: number, durationMs: number): PlaybackClock {
  if (!clock.playing) return clock;
  const time = Math.min(durationMs, clock.time + elapsedMs * clock.speed);
  return { ...clock, time, playing: time < durationMs };
}

/** Starts playing; at the end it starts again from the beginning. */
export function playFrom(clock: PlaybackClock, durationMs: number): PlaybackClock {
  return { ...clock, time: clock.time >= durationMs ? 0 : clock.time, playing: true };
}

/** Jumps to `time`, kept within the recording. */
export function seek(clock: PlaybackClock, time: number, durationMs: number): PlaybackClock {
  return { ...clock, time: Math.min(durationMs, Math.max(0, time)) };
}

/** Pauses and moves to the next (1) or previous (−1) snapshot moment; stays at the first and last one. */
export function step(clock: PlaybackClock, times: readonly number[], direction: 1 | -1): PlaybackClock {
  const next =
    direction > 0 ? times.find((t) => t > clock.time) : [...times].reverse().find((t) => t < clock.time);
  return { ...clock, playing: false, time: next ?? clock.time };
}
