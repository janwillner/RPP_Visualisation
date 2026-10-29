# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language

Everything in this project is written in English: code, identifiers, comments, docs, ADRs, glossary, issues, PRs and commit messages. This applies even when the conversation with the user is in German.

## Commands

pnpm monorepo (pnpm 12 via corepack; prefix with `corepack` if `pnpm` is not on PATH).

- `pnpm install`
- `pnpm test`: all Vitest projects. Single file: `pnpm vitest run apps/web/test/scene-model.test.ts`. Single test: add `-t "<name>"`.
- `pnpm typecheck`: `tsc` in every package
- `pnpm dev:gateway`: gateway with the simulator on :8080
- `pnpm dev:web`: Vite dev server that proxies `/ws` to the gateway (override with `GATEWAY_URL`)
- `pnpm build`: builds `apps/web/dist`. `pnpm start -- --driver ads --ams-net-id <id>` then serves it plus the WebSocket on one port (`--help` lists the options).

## Architecture

A read-only web visualisation of packaging machines. It configures itself from what the PLC reports. Spec: GitHub issue #1.

- `packages/protocol`: the neutral data model (zod schemas plus types) shared by gateway and web, and the Delta kinematics, since the angle convention is part of the contract. All values are MCS: mm, degrees, Z up.
- `apps/gateway`: Node + TypeScript, run with tsx.
  - `createGateway` does discovery (manifest at `GVL_Visu.stManifest` → protocol version check → type check per entry → read `stConfig`) and cyclic sum-reads of every `stState` together with `nConfigVersion`. It emits `status` / `config` / `state` messages.
  - **Seam:** `SymbolAccess` (read / typeOf / sumRead). It has two adapters: `AdsSymbolAccess` (ads-client) and `InMemoryPlc`.
  - The simulator is just an `InMemoryPlc` preset that changes values on every `step`, so it runs through real discovery.
  - PLC struct shapes and their mapping to the neutral model live in `plc-contract.ts` and `mapping.ts`. The ST declarations are in `docs/plc-contract.md`; keep all three in sync.
- `apps/web`: React + React Three Fiber.
  - **Seam:** `buildScene(config, snapshots, renderTime)` in `src/scene/scene-model.ts` is pure. It does interpolation by `tRel`, latch + encoder product positions, the product display lifecycle (normal / atTcp / placeholder / missed), Delta forward kinematics, windows and work areas, and MCS → renderer conversion (`(x, y, z)mm → (x, z, −y)m`).
  - `SceneView.tsx` only draws the model and updates transforms per frame via refs. React re-renders only when the set of objects changes.
  - `connection.ts` buffers snapshots and renders `RENDER_DELAY_MS` behind the newest one.
- Tests live only at the two seams: gateway tests drive an `InMemoryPlc` and assert on emitted messages; web tests call `buildScene`. Rendering is not tested.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on janwillner/RPP_Visualisation (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
