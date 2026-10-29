# Status

Snapshot of where the work stands, for picking it up later. Spec: GitHub issue #1. Branch: `feat/mvp-visualisation`.

## How to run it against the PLC

1. Open `plc/ProductConfigurator.sln` in TwinCAT XAE (4026, user-mode runtime `UmRT_Default`, target `169.254.123.103.1.1`, which is this PC).
2. Build, activate the configuration, log in and start the PLC. If the manifest looks stale after an online change, do a cold reset and start again.
3. `corepack pnpm install`, `corepack pnpm build:bridge`, `corepack pnpm --filter @rpp/web build`
4. `cd apps/gateway && node_modules/.bin/tsx src/main.ts --driver ads --ams-net-id 169.254.123.103.1.1 --ads-port 851 --port 8080`
5. Open http://localhost:8080

Without a PLC: `--driver sim` (built-in simulator, same contract).

## Done

- MVP from issue #1: protocol package, gateway (discovery, sum-read snapshots, version checks, reconnect), simulator, React Three Fiber debug UI.
- PLC library `Syn_Visu` (`plc/Syn_Visu`), contract in `docs/plc-contract.md`, **protocol version 2**.
- ADS access through `apps/ads-bridge` (.NET, Beckhoff `TwinCAT.Ads` 7.0.389), because the pure TCP client `ads-client` is rejected by the 4026 user-mode runtime's router (no AMS TCP loopback, no route). `ads-client` remains as `--driver ads-tcp`.
- Delta reports only its TCP; the web derives the arms by inverse kinematics (was: axis angles in protocol version 1).
- Delta drawn like a real robot: base plate, motors, upper arms, parallelogram lower arms, effector with TCP axis triad.
- MCS coordinate readout under the pointer; Shift+click places measuring points.
- Gateway re-runs discovery every second (`--config-recheck-ms`), so configs changed live in the PLC appear without bumping `nConfigVersion`.
- Demo line in the PLC project (`P_VisuDemo`): two infeeds, one outfeed, three Deltas in a row.

## Deviations from the spec in issue #1

- ADS via the .NET bridge instead of `ads-client` (spec Q10 chose pure TypeScript).
- Delta state is TCP only; no axis angles, no axis calibration (`aAxes`), no "drawn effector vs. PLC TCP" cross-check.
- Third browser message kind `status`.
- The manifest `GVL_Visu.stManifest` is declared by the application, not by the library.
- A rejected product past the belt end is hidden instead of flagged as missed.

## Open

- **Demo objects live inside the library project** (`GVL_Visu`, `P_VisuDemo`, `F_VisuDemoCompact`, `F_VisuDemoMoveToward`, the `PlcTask` reference and the `Tc3_Module` reference it needs). They must be removed, or moved to a separate application project, before releasing the library.
- **Exporting `Syn_Visu.library` fails** with a COM error; most likely the project information (Company, Title, Version) is missing. Set it in XAE, then save as library.
- `GVL_VisuParam` is a plain constant GVL, not a library parameter list, so array sizes are not yet overridable per project.
- Write ADRs for: ADS bridge instead of `ads-client`, TCP-only Delta (protocol v2), manifest owned by the application, periodic config recheck.
- Update the spec in issue #1 to the decisions above.
- Ideas raised but not built: belt-X readout and distance between measuring points; Delta part sizes scaled with the configured geometry.
- Local machine leftovers from the ADS investigation (not needed any more): `EnableAmsTcpLoopback` in the Windows registry and in `UmRT_Default\3.1\TcRegistry.xml`.
