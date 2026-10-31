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
- `pnpm build`: builds `apps/web/dist`. `pnpm build:bridge`: builds the .NET ADS bridge (`apps/ads-bridge`, needs the .NET 9 SDK).
- `pnpm start -- --driver ads --ams-net-id <id>` serves the built app plus the WebSocket on one port (`--help` lists the options; `--config <file>` reads them from JSON, flags win).
- `pnpm package`: builds the self-contained Windows package for IPCs, `dist/rpp-visualisation-<version>-win-x64.zip` (Windows, .NET SDK). Deployment: `docs/deployment.md`, ADR 0004; install scripts in `deploy/windows/`.

## Architecture

A read-only web visualisation of packaging machines. It configures itself from what the PLC reports. Spec: GitHub issue #1.

- `packages/protocol`: the neutral data model (zod schemas plus types) shared by gateway and web, and the Delta kinematics. All values are MCS: mm, degrees, Z up. A Delta reports only its TCP; the web derives the arms by inverse kinematics. XTS gantries (e.g. IDH) report their Z axis and per mover track position, X, C and gripper; XTS loops (e.g. Fxx) report per mover the position along the loop. Cartesian robots report their X, Y, Z axes and gripper. Deltas may have a limit area (box in the robot frame); every zone may have an allocation offset. Every kinematics may define gripper fingers (cylinders) whose poses the PLC reports absolute in the MCS; tool rotations exist only through them, and a picked product hangs at its `fingerId`. Every component and every XTS mover may report a fault with a message (protocol version 8).
- `apps/gateway`: Node + TypeScript, run with tsx.
  - `createGateway` does discovery (manifest at `GVL_Visu.stManifest` → protocol version check → type check per entry → read `stConfig`) and cyclic sum-reads of every `stState` together with `nConfigVersion`. It emits `status` / `config` / `state` messages.
  - **Seam:** `SymbolAccess` (read / typeOf / sumRead). Adapters:
    - `AdsBridgeSymbolAccess` (`--driver ads`, default for real PLCs): spawns `apps/ads-bridge` (the self-contained `AdsBridge.exe` when packaged, else the dll through `dotnet`; see `bridgeLaunch`), a small C# process using Beckhoff's official `TwinCAT.Ads` library. It talks to the local AMS router like any TwinCAT app, so no route or AMS TCP loopback is needed. One JSON request/response per line on stdin/stdout; the bridge converts raw PLC memory to JSON from the type information (64-bit integers as strings).
    - `AdsSymbolAccess` (`--driver ads-tcp`): pure TCP client (`ads-client`). Needs a static route or AMS TCP loopback, which the TwinCAT 4026 user-mode runtime does not provide out of the box.
    - `InMemoryPlc`: tests and the simulator.
  - The simulator is just an `InMemoryPlc` preset that changes values on every `step`, so it runs through real discovery.
  - PLC struct shapes and their mapping to the neutral model live in `plc-contract.ts` and `mapping.ts`. The PLC library `Syn_Visu` (library project `plc/Syn_Visu`, demo application `plc/Syn_Visu_Demo` on ADS port 852, exported releases in `plc/library/`, all in `plc/RPP_Visu.sln`) implements the contract described in `docs/plc-contract.md`; keep library, `plc-contract.ts` and doc in sync. PLC code is edited only through the TwinCAT MCP tools and follows `docs/plc-coding-guidelines.md` (company guideline; `Syn_Visu`'s contract names stay Beckhoff-style).
- `apps/web`: React + React Three Fiber.
  - **Seam:** `buildScene(config, snapshots, renderTime, hidden)` in `src/scene/scene-model.ts` is pure. It does hiding of user-hidden components, interpolation by `tRel`, latch + belt product positions, the product display lifecycle (normal / atTcp / placeholder / missed), Delta arms from the TCP (inverse kinematics), XTS gantry and loop movers (loop curves as semicircles) and products carried by movers, Cartesian robot parts and flange, gripper fingers and products carried by them, faults (red parts, labels and the per-component fault list), zones with their allocation areas, working areas and limit areas, the measure-mode snap points and component origins, and MCS → renderer conversion (`(x, y, z)mm → (x, z, −y)m`).
  - `SceneView.tsx` only draws the model and updates transforms per frame via refs. React re-renders only when the set of objects changes.
  - `connection.ts` buffers snapshots and renders `RENDER_DELAY_MS` behind the newest one.
- Tests live only at the seams: gateway tests drive an `InMemoryPlc` and assert on emitted messages; web tests call `buildScene`. Two small gateway seams for deployment are tested too: `resolveGatewayOptions` (flags, config file, default paths packaged vs. repo) and `bridgeLaunch` (exe vs. dll). Rendering is not tested; the package is checked by a smoke run.

## TwinCAT MCP

- TwinCAT projects may be closed. If a call fails because no XAE is running (`find_projects` lists nothing, or RPC 0x800706BA), open the solution yourself: start `C:\Program Files\Beckhoff\TcXaeShell\Common7\IDE\TcXaeShell.exe "plc\RPP_Visu.sln"`, wait until the window title shows `RPP_Visu`, then call `initialize`.
- If a TwinCAT MCP call has not answered after 5 minutes, do not keep waiting. Retry it once (after `initialize` again). If it hangs again, try another way: a different tool for the same goal, smaller steps, or check whether XAE shows a modal dialog and ask the user to close it.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on janwillner/RPP_Visualisation (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
