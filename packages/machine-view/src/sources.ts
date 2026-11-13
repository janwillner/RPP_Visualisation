import type { ConfigMessage, GatewayMessage, GatewayStatus, Machine, StateMessage, StatusMessage } from "@rpp/protocol";
import type { SceneSource } from "./scene/scene-model";

/**
 * What the web app knows about every PLC source at one moment, folded from the gateway's messages: name, status and
 * config, the states of the current config version and the time to render each source at. Live and playback both
 * take their sources from here; it has no clock of its own, every time is given (`at`: arrival, ms on any axis).
 */

/** Render this far behind the newest snapshot so there is always a later sample to interpolate to. */
export const RENDER_DELAY_MS = 40;
/** States kept for interpolation, back from a source's newest one (at least two are kept). */
const WINDOW_MS = 1000;
/** `lastError` of the status recorded for every source when the browser loses the gateway. */
export const GATEWAY_LOST = "Connection to the gateway lost";

/** What the UI knows about one PLC source. */
export interface SourceInfo {
  sourceId: string;
  name: string;
  /** Undefined until the first status arrives. */
  status: GatewayStatus | undefined;
  /** The last config, kept while the source is offline. */
  config: ConfigMessage | undefined;
  /**
   * The machine as its application last reported it (run state, simulation mode, machine messages; ADR 0021), kept
   * while the source is offline; undefined for an application without the machine entry.
   */
  machine?: Machine | undefined;
}

/** Whether the gateway currently reads this source's PLC (false for all after the gateway connection was lost). */
export function isOnline(source: SourceInfo): boolean {
  return source.status?.plcConnected === true;
}

/** One source's states of its current config version and timeline, with their arrival. */
interface Timeline {
  snapshots: StateMessage[];
  arrivals: number[];
}

export class Sources {
  private list: readonly SourceInfo[];
  private readonly timelines = new Map<string, Timeline>();
  private readonly lastStates = new Map<string, number>();

  /** `initial`: every source as it is where these sources start, e.g. at a recording block's start. */
  constructor(initial: readonly SourceInfo[] = []) {
    this.list = [...initial];
  }

  /**
   * Every source in the order first heard of. A new array whenever a source's name, status, config or machine changes, the
   * same one after a state; a `SourceInfo` is never changed, only replaced.
   */
  get all(): readonly SourceInfo[] {
    return this.list;
  }

  /**
   * Applies a message that arrived at `at` and returns its source as it is now. A state counts only for its source's
   * current config version; a new config version, or a tRel that restarts (the gateway rediscovered), starts a new
   * timeline.
   */
  apply(at: number, message: GatewayMessage): SourceInfo {
    const i = this.list.findIndex((s) => s.sourceId === message.sourceId);
    const current = this.list[i] ?? { sourceId: message.sourceId, name: message.sourceId, status: undefined, config: undefined };
    let next: SourceInfo;
    switch (message.kind) {
      case "state":
        if (message.configVersion === current.config?.configVersion) this.push(at, message);
        return current;
      case "status":
        next = { ...current, name: message.sourceName, status: message.status };
        break;
      case "config":
        // A refreshed config of the same version keeps the timeline.
        if (message.configVersion !== current.config?.configVersion) this.timelines.delete(message.sourceId);
        next = { ...current, config: message };
        break;
      case "machine": {
        const { kind: _kind, sourceId: _sourceId, ...machine } = message;
        next = { ...current, machine };
        break;
      }
    }
    this.list = i < 0 ? [...this.list, next] : this.list.map((s, j) => (j === i ? next : s));
    return next;
  }

  /** Every source as the machine scene takes it, rendered at `t` (on the axis of the `at` values). */
  sceneSources(t: number): SceneSource[] {
    return this.list.map((s) => {
      const timeline = this.timelines.get(s.sourceId);
      return {
        sourceId: s.sourceId,
        config: s.config,
        snapshots: timeline?.snapshots ?? [],
        renderTime: timeline ? renderTime(timeline, t) : 0,
        online: isOnline(s),
      };
    });
  }

  /** A source's newest state of its current config version. */
  latestState(sourceId: string): StateMessage | undefined {
    return this.timelines.get(sourceId)?.snapshots.at(-1);
  }

  /** When the source's last state arrived, also one of an older config version or timeline. */
  lastStateAt(sourceId: string): number | undefined {
    return this.lastStates.get(sourceId);
  }

  /**
   * The status messages that tell, for every source, that the gateway connection was lost: the browser applies and
   * records them like the gateway's own, so recordings and the replay buffer show the sources offline (ADR 0006).
   */
  gatewayLost(): StatusMessage[] {
    return this.list.map((s) => ({
      kind: "status",
      sourceId: s.sourceId,
      sourceName: s.name,
      status: { plcConnected: false, lastError: GATEWAY_LOST },
    }));
  }

  private push(at: number, state: StateMessage): void {
    this.lastStates.set(state.sourceId, at);
    let timeline = this.timelines.get(state.sourceId);
    if (!timeline || state.tRel < timeline.snapshots.at(-1)!.tRel) {
      timeline = { snapshots: [], arrivals: [] };
      this.timelines.set(state.sourceId, timeline);
    }
    timeline.snapshots.push(state);
    timeline.arrivals.push(at);
    const oldest = state.tRel - WINDOW_MS;
    while (timeline.snapshots.length > 2 && timeline.snapshots[0]!.tRel < oldest) {
      timeline.snapshots.shift();
      timeline.arrivals.shift();
    }
  }
}

/**
 * Time on the source's tRel axis to render at `t`, RENDER_DELAY_MS behind and never past the newest state. `t` is
 * mapped to tRel by the smallest (arrival − tRel) over the timeline, so a late arrival never pulls the clock backwards.
 */
function renderTime({ snapshots, arrivals }: Timeline, t: number): number {
  let offset = Infinity;
  for (let i = 0; i < snapshots.length; i++) offset = Math.min(offset, arrivals[i]! - snapshots[i]!.tRel);
  return Math.min(snapshots.at(-1)!.tRel, t - offset - RENDER_DELAY_MS);
}
