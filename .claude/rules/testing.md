---
paths:
  - "**/test/**"
  - "**/e2e/**"
  - "**/bench/**"
  - "**/*.test.ts"
  - "**/*.e2e.ts"
---

# Tests

Tests live only at the seams each area's rule names, and assert on what the seam gives (messages, snapshots, the
page), never on internals. Commands: `.claude/docs/commands.md`.

## Unit tests (Vitest, `pnpm test`)

- **Gateway**: drive an `InMemoryPlc` (or several, combined) and assert on emitted messages; whole machines use
  `test/fixture-machine.ts`. Syn_Config through `config-emulation.ts` (`parameters.test.ts`, `recipes.test.ts`,
  `machine.test.ts`). The docs page at the gateway seam (`docs-page.test.ts`: diagrams inlined with unique ids, links
  resolve, every schema field described, the fixture's messages valid against the JSON Schema); `web-pages.test.ts`
  for the three apps' paths. Deployment seams: `resolveGatewayOptions`, `bridgeLaunch`, the bridge process, `/health`.
- **Protocol**: `writeBlockedReason` by a table (`packages/protocol/test`).
- **machine-view**: `buildScene`, `buildMachineScene`, `Sources`, `GatewayLive` over `FakeConnection`,
  `ProductHistory`, `metrics`, `parseViewSettings`, `stateRows`, `picking.ts`, `product-groups.ts`, `scene-frame.ts`.
- **Visualisation**: the `Viewer`, the recording (any moment, config changes, registers, timeline events, limit, file
  round trip), the replay buffer's snapshot, the playback clock.
- **Configurator**: the `Configurator` (`configurator*.test.ts`: placing, editing, undo / redo, problems, draft file,
  every palette type, gripper layout, live reconciliation, writing) over `FakeGateway`.
- **Simulator**: the `Simulator` (`simulator.test.ts`) over `FakeGateway`.

`FakeConnection` / `FakeGateway` come from `@rpp/machine-view/testing`: the real `GatewayLive` over a fake socket
that records commands and answers them. A new configuration makes `GatewayLive` drop that source's parameter sets, as
the real gateway does: send them again in a test.

## Browser tests (Playwright, `e2e/` of each app)

Rendering is not unit tested; the browser tests drive each built app against the demo PLC (`docs/demo-plc.md`)
through its main flows, and check that the build is split into parts of at most 800 KB (`manualChunks` in
`scripts/web-app-build.mjs`). Each test starts from a fresh browser context. A test that changes the demo (a written
parameter set or recipe, a stopped machine) returns it to its program values and running state; Simulator tests do
this in `openAtProgramValues`.

## PLC unit tests

TcUnit in `plc/Syn_Visu_Test` (see the PLC rule).

## Benchmarks

`pnpm bench` in `apps/*/bench/`, 500 to 4800 products on one conveyor; compare runs before and after a change
(`docs/performance.md`).
