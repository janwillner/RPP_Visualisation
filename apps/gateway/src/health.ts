import { PROTOCOL_VERSION } from "@rpp/protocol";
import type { MessageSource } from "./gateway";

export interface SourceHealth {
  sourceId: string;
  name: string;
  plcConnected: boolean;
  lastError?: string;
  /** Wall-clock time of the newest state snapshot, ISO 8601; absent before the first one. */
  lastStateAt?: string;
  /** Version of the Syn_Visu library the PLC runs, once discovered (library 5.1 and newer). */
  libraryVersion?: string;
}

export interface HealthReport {
  /** Every source is connected (and there is at least one). */
  ok: boolean;
  /** Version of this visualisation release. */
  version: string;
  protocolVersion: number;
  sources: SourceHealth[];
}

/**
 * Follows the gateway messages and answers how every source is doing, for monitoring (`GET /health`). Sources appear
 * in the order of their first status message, which follows the configured order.
 */
export function watchHealth(
  gateway: MessageSource,
  version: string,
  now: () => number = Date.now,
): () => HealthReport {
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
        ...(previous?.libraryVersion ? { libraryVersion: previous.libraryVersion } : {}),
      });
    } else if (message.kind === "config") {
      const source = sources.get(message.sourceId);
      if (!source) return;
      if (message.libraryVersion) source.libraryVersion = message.libraryVersion;
      else delete source.libraryVersion;
    } else if (message.kind === "state") {
      const source = sources.get(message.sourceId);
      if (source) source.lastStateAt = new Date(now()).toISOString();
    }
  });
  return () => {
    const list = [...sources.values()].map((s) => ({ ...s }));
    return {
      ok: list.length > 0 && list.every((s) => s.plcConnected),
      version,
      protocolVersion: PROTOCOL_VERSION,
      sources: list,
    };
  };
}
