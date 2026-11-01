import { PROTOCOL_VERSION } from "@rpp/protocol";
import type { MessageSource } from "./gateway";

export interface SourceHealth {
  sourceId: string;
  name: string;
  plcConnected: boolean;
  lastError?: string;
  /** Wall-clock time of the newest state snapshot, ISO 8601; absent before the first one. */
  lastStateAt?: string;
}

export interface HealthReport {
  /** Every source is connected (and there is at least one). */
  ok: boolean;
  protocolVersion: number;
  sources: SourceHealth[];
}

/**
 * Follows the gateway messages and answers how every source is doing, for monitoring (`GET /health`). Sources appear
 * in the order of their first status message, which follows the configured order.
 */
export function watchHealth(gateway: MessageSource, now: () => number = Date.now): () => HealthReport {
  const sources = new Map<string, SourceHealth>();
  gateway.subscribe((message) => {
    if (message.kind === "status") {
      const previous = sources.get(message.sourceId);
      sources.set(message.sourceId, {
        sourceId: message.sourceId,
        name: message.sourceName,
        plcConnected: message.status.plcConnected,
        ...(message.status.lastError ? { lastError: message.status.lastError } : {}),
        ...(previous?.lastStateAt ? { lastStateAt: previous.lastStateAt } : {}),
      });
    } else if (message.kind === "state") {
      const source = sources.get(message.sourceId);
      if (source) source.lastStateAt = new Date(now()).toISOString();
    }
  });
  return () => {
    const list = [...sources.values()].map((s) => ({ ...s }));
    return { ok: list.length > 0 && list.every((s) => s.plcConnected), protocolVersion: PROTOCOL_VERSION, sources: list };
  };
}
