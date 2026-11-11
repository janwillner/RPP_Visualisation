import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type ConfigMessage, type StateMessage, type StatusMessage } from "@rpp/protocol";
import { GATEWAY_LOST, RENDER_DELAY_MS, Sources, isOnline } from "../src/sources";

const A = "ads:5.1.2.3.1.1:851";
const B = "ads:5.1.2.4.1.1:851";

function config(sourceId: string, configVersion = 1): ConfigMessage {
  return { kind: "config", sourceId, protocolVersion: PROTOCOL_VERSION, configVersion, errors: [], components: [] };
}

function state(sourceId: string, tRel: number, configVersion = 1): StateMessage {
  return { kind: "state", sourceId, configVersion, timestamp: "0", tRel, components: [] };
}

function status(sourceId: string, plcConnected: boolean, sourceName = "Infeed PLC"): StatusMessage {
  return { kind: "status", sourceId, sourceName, status: { plcConnected } };
}

/** A with status and config version 1, then a state every 20 ms from `from` to `to` (arrival = tRel + 100). */
function running(from = 0, to = 2000): Sources {
  const sources = new Sources();
  sources.apply(0, status(A, true));
  sources.apply(0, config(A));
  for (let t = from; t <= to; t += 20) sources.apply(t + 100, state(A, t));
  return sources;
}

const tRels = (sources: Sources, sourceId = A) =>
  sources.sceneSources(0).find((s) => s.sourceId === sourceId)!.snapshots.map((s) => s.tRel);

describe("sources: what the web app knows about every PLC source", () => {
  it("names a source from its status and keeps its config, in the order first heard of", () => {
    const sources = new Sources();
    sources.apply(0, status(B, true, "Outfeed PLC"));
    const a = sources.apply(0, status(A, false));
    sources.apply(0, config(A, 3));

    expect(a).toEqual({ sourceId: A, name: "Infeed PLC", status: { plcConnected: false }, config: undefined });
    expect(sources.all.map((s) => [s.sourceId, s.name, s.status?.plcConnected, s.config?.configVersion])).toEqual([
      [B, "Outfeed PLC", true, undefined],
      [A, "Infeed PLC", false, 3],
    ]);
  });

  it("replaces a source's info when its status or config changes, never when a state arrives", () => {
    const sources = running(0, 100);
    const before = sources.all;
    const info = before[0]!;

    sources.apply(200, state(A, 120));
    expect(sources.all).toBe(before);

    sources.apply(300, status(A, false));
    expect(sources.all).not.toBe(before);
    expect(info.status?.plcConnected).toBe(true);
  });

  it("takes states only of the source's current config version", () => {
    const sources = new Sources();
    sources.apply(0, state(A, 0));
    expect(sources.all).toEqual([]);

    sources.apply(0, config(A, 2));
    sources.apply(10, state(A, 10, 1));
    sources.apply(20, state(A, 20, 2));
    expect(tRels(sources)).toEqual([20]);
  });

  it("starts a new timeline with a new config version, not with a refreshed config of the same one", () => {
    const sources = running(0, 100);
    sources.apply(500, config(A, 1));
    expect(tRels(sources)).toHaveLength(6);

    sources.apply(600, config(A, 2));
    expect(tRels(sources)).toEqual([]);
    expect(sources.latestState(A)).toBeUndefined();
  });

  it("starts a new timeline when tRel restarts (the gateway rediscovered)", () => {
    const sources = running(0, 1000);
    sources.apply(2000, state(A, 5));

    expect(tRels(sources)).toEqual([5]);
  });

  it("keeps the states of the last second before the newest one, but at least two", () => {
    expect(tRels(running(0, 2000))[0]).toBe(1000);
    expect(tRels(running(0, 2000))).toHaveLength(51);

    const sources = running(0, 0);
    sources.apply(5100, state(A, 5000));
    sources.apply(9100, state(A, 9000));
    expect(tRels(sources)).toEqual([5000, 9000]);
  });

  it("renders RENDER_DELAY_MS behind, on each source's own tRel axis, never past the newest state", () => {
    const sources = running(0, 2000);
    sources.apply(0, config(B));
    for (let t = 0; t <= 2000; t += 20) sources.apply(t + 100, state(B, t + 5000));

    const [a, b] = sources.sceneSources(1600);
    expect(a!.renderTime).toBe(1500 - RENDER_DELAY_MS);
    expect(b!.renderTime).toBe(6500 - RENDER_DELAY_MS);
    expect(sources.sceneSources(99_999)[0]!.renderTime).toBe(2000);
  });

  it("maps arrival to tRel by the earliest arrival, so a late state does not pull the clock back", () => {
    const sources = running(0, 1000);
    // Arrives 300 ms late.
    sources.apply(1320, state(A, 1020));

    // Offset 100 from the punctual states; the late one's 300 would give 760.
    expect(sources.sceneSources(1100)[0]!.renderTime).toBe(1000 - RENDER_DELAY_MS);
  });

  it("gives the newest state and when the last state arrived", () => {
    const sources = running(0, 1000);
    sources.apply(1500, config(A, 2));

    expect(sources.latestState(A)).toBeUndefined();
    expect(sources.lastStateAt(A)).toBe(1100);
    expect(sources.lastStateAt(B)).toBeUndefined();
  });

  it("counts a source online only while the gateway reads its PLC", () => {
    const sources = running(0, 100);
    sources.apply(0, config(B));

    expect(sources.sceneSources(0).map((s) => s.online)).toEqual([true, false]);
    expect(sources.all.map(isOnline)).toEqual([true, false]);
  });

  it("tells for every source that the gateway was lost; applied, they are all offline", () => {
    const sources = running(0, 100);
    sources.apply(0, status(B, false, "Outfeed PLC"));

    const lost = sources.gatewayLost();
    expect(lost).toEqual([
      { kind: "status", sourceId: A, sourceName: "Infeed PLC", status: { plcConnected: false, lastError: GATEWAY_LOST } },
      { kind: "status", sourceId: B, sourceName: "Outfeed PLC", status: { plcConnected: false, lastError: GATEWAY_LOST } },
    ]);
    for (const message of lost) sources.apply(500, message);
    expect(sources.sceneSources(500).map((s) => s.online)).toEqual([false, false]);
    // The last states stay, to be drawn faded.
    expect(sources.latestState(A)?.tRel).toBe(100);
  });
});
