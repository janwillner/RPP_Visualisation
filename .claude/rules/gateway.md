---
paths:
  - "apps/gateway/**"
  - "apps/ads-bridge/**"
---

# Gateway (`apps/gateway`, Node + TypeScript run with tsx)

`createGateway` reads one PLC source (AmsNetId + ADS port):

- **Discovery**: the manifest at `GVL_Visu.stManifest` → protocol version check → type check per entry
  (`isExpectedType`; library types may carry their namespace) → each `stConfig`; the machine entry next to it
  (ADR 0021); the Syn_Config FBs (see the parameter-sets rule).
- **Cycle**: one sum-read of every part together with `nConfigVersion`; a changed version rediscovers. Each part
  (states, each parameter FB, the machine FB, the machine entry) is a `ReadPart` with its own paths, mapping and
  changes memory (`read-parts.ts`); the gateway joins their paths and hands each its own values.
- It emits `status` / `config` / `state` and, when they change, `parameters` and `machine`, each with its
  `sourceId`, and waits `RECONNECT_MS` after a failure. Manifest ids are unique only per source.

Several sources (other IPCs over ADS routes, ADR 0005) each get their own gateway; `combineGateways` merges them.

## Server

Turns every message into JSON once for all browsers. A client on `/ws?changes=1` (the web apps) gets states in
register form: per conveyor only the changed products plus `registers` (the id order), from one shared
`RegisterEncoder`, and every product again after connecting or a dropped state (ADR 0013). `GET /health` reports per
source connected / last error / last state plus `acquisition` (`acquisition-stats.ts`), 200 or 503. It serves the
apps (`/`, `/configurator/`, `/simulator/`), the PLC library guide at `/docs` (built in memory from
`docs/plc-library-guide.md` with its inlined diagrams, ADR 0014) and `/docs/schema.json`. `docs/api.md` documents the
WebSocket for client programmers.

## Seam: `SymbolAccess` (read / typeOf / sumRead / sumWrite)

`sumRead(paths, { changes })` may give a product register as changes (`$ids` in order, `$changed` entries) within a
session the gateway starts on every discovery; the mapping maps only those and keeps the other product objects. An
unknown id starts a new session and reads again. Adapters:

- `AdsBridgeSymbolAccess` (`--driver ads`, default): spawns `apps/ads-bridge`, a C# process on Beckhoff's
  `TwinCAT.Ads`, talking to the local AMS router (no route or AMS TCP loopback needed). One JSON request/response per
  line on stdin/stdout; 64-bit integers as strings. Of an array with a count member it reads only the counted entries
  plus a reserve (`ReadPlan.cs`); asked for changes it compares each entry's bytes by `nId` and converts only changed
  ones. It writes in one ADS sum-write (`SumWrite.cs`), mapping indices from 0 to the PLC's lower bound.
- `AdsSymbolAccess` (`--driver ads-tcp`): pure TCP; needs a route or AMS TCP loopback; cannot write.
- `InMemoryPlc`: the tests' PLC, built with `plc-builders.ts`, registers as changes like the bridge. Tests needing a
  whole machine use `test/fixture-machine.ts`, one component of every type.

## PLC mapping

PLC struct shapes live in `plc-contract.ts`. Mapping to the neutral model is generic (`plc-mapping.ts`): it walks the
zod schema and finds each field's member by the naming convention (Hungarian prefix, array + count member, `bValid`
entries, `bActive` for nullable structures, enums by index unless a table is registered). Register exceptions
(`registerEnumTable`, `ALIASES`) instead of writing a mapper. `components.ts` holds per type the manifest value and the
PLC types of its contract structure and of its parameter FB.

## Options and packaging

`resolveGatewayOptions` merges flags and `--config <file>` (flags win); default paths differ packaged vs. repo.
`bridgeLaunch` picks `AdsBridge.exe` when packaged, else the dll through `dotnet`. Packaging: ADR 0004.
