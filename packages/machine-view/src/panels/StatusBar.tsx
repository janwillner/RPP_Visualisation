import { useState } from "react";
import { GatewayConnection, STALE_AFTER_MS, type ConnectionSnapshot } from "../gateway-connection";
import type { MachineScene } from "../scene/scene-model";
import { runStateText } from "../machine-facts";
import { isOnline, type SourceInfo } from "../sources";
import { useTick } from "../use-tick";
import { StatusList } from "./StatusList";
import { APP_VERSION } from "../version";

/** Sources the gateway cannot read right now (all of them while the gateway connection is down). */
export function offlineSources(gateway: ConnectionSnapshot): readonly SourceInfo[] {
  return gateway.sources.filter((s) => !isOnline(s));
}

/** Milliseconds since the newest data of the stalest connected source; undefined before any data. */
function dataAge(store: GatewayConnection, gateway: ConnectionSnapshot): number | undefined {
  const ages = gateway.sources
    .filter(isOnline)
    .map((s) => store.dataAge(s.sourceId))
    .filter((a): a is number => a !== undefined);
  return ages.length ? Math.max(...ages) : undefined;
}

export function StatusBar(props: {
  store: GatewayConnection;
  gateway: ConnectionSnapshot;
  modelRef: React.RefObject<MachineScene | undefined>;
}) {
  const { store, gateway, modelRef } = props;
  useTick(250);
  const [showSources, setShowSources] = useState(false);
  const age = dataAge(store, gateway);
  const stale = age === undefined || age > STALE_AFTER_MS;
  const several = gateway.sources.length > 1;
  const prefix = (source: SourceInfo) => (several ? `${source.name}: ` : "");
  const errors = [
    ...gateway.sources.flatMap(
      (source) => source.config?.errors.map((e) => `${prefix(source)}${e.path ?? ""} ${e.message}`.trim()) ?? [],
    ),
    ...(modelRef.current?.sources.flatMap((x) => {
      const source = gateway.sources.find((s) => s.sourceId === x.sourceId);
      return x.scene.warnings.map((w) => (source ? prefix(source) + w : w));
    }) ?? []),
    ...(gateway.protocolError ? [`Protocol: ${gateway.protocolError}`] : []),
  ];
  const online = gateway.sources.length - offlineSources(gateway).length;
  const single = several ? undefined : gateway.sources[0];
  return (
    <footer className="statusbar">
      <span className={gateway.socket === "open" ? "ok" : "bad"}>Gateway: {gateway.socket}</span>
      {several ? (
        <button
          className={online === gateway.sources.length ? "ok link" : "bad link"}
          onClick={() => setShowSources((v) => !v)}
        >
          PLC: {online}/{gateway.sources.length} online
        </button>
      ) : (
        <span className={single?.status?.plcConnected ? "ok" : "bad"}>
          PLC: {single?.status ? (single.status.plcConnected ? "connected" : "not connected") : "unknown"}
          {single?.status?.lastError && !single.status.plcConnected ? ` (${single.status.lastError})` : ""}
        </span>
      )}
      <span className={stale ? "bad" : "ok"}>
        Data age: {age === undefined ? "–" : `${Math.round(age)} ms`}
        {stale ? " – stale" : ""}
      </span>
      {single?.machine && isOnline(single) && (
        <span className={`run-state ${single.machine.runState}`}>Machine: {runStateText(single.machine)}</span>
      )}
      {single?.config && <span className="muted">Config v{single.config.configVersion}</span>}
      {single?.config?.libraryVersion && <span className="muted">Syn_Visu {single.config.libraryVersion}</span>}
      <StatusList items={errors.map((text) => ({ text, severity: "error" }))} noun={["discovery error", "discovery errors"]} />
      <a className="muted link statusbar-api" href="/docs" target="_blank" rel="noopener" title="Guide to the PLC library Syn_Visu">
        PLC guide
      </a>
      <span className="muted statusbar-version" title="Version of the RPP tools">
        v{APP_VERSION}
      </span>
      {showSources && several && (
        <ul className="errors sources-list">
          {gateway.sources.map((source) => {
            const connected = isOnline(source);
            // A connected PLC can still be unusable, e.g. with another protocol version: show its first error.
            const problem = connected ? source.config?.errors[0]?.message : source.status?.lastError;
            return (
              <li key={source.sourceId}>
                <span className={connected ? "ok" : "bad"}>{connected ? "online" : "offline"}</span>{" "}
                <strong>{source.name}</strong> <span className="muted">{source.sourceId.replace(/^ads:/, "")}</span>
                {source.config && <span className="muted"> · config v{source.config.configVersion}</span>}
                {source.config?.libraryVersion && (
                  <span className="muted"> · Syn_Visu {source.config.libraryVersion}</span>
                )}
                {problem && <span className="bad"> · {problem}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </footer>
  );
}
