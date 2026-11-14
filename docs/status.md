# Status

Where the work stands, for picking it up later. Spec: GitHub issue #1 (closed; where they differ, the docs and ADRs
win). Work goes onto `main` through pull requests; releases are `v*` tags (`docs/releasing.md`). What was built and
when: the closed issues and pull requests, and the history of this file (`git log -p docs/status.md`).

## Current state

- Release 0.9.0: the visualisation (`/`), the configurator (`/configurator/`) and the Simulator (`/simulator/`),
  served by one gateway per IPC, installed as a Windows service (ADR 0004).
- Protocol 22 (machine entry, ADR 0021) with the PLC library Syn_Visu 10.0.0; the gateway still reads protocol 21.
- Config protocol 4 with Syn_Config 2.3.0: parameter sets (ADR 0017), recipes with labels, descriptions and visibility
  conditions, and machine commands (ADR 0022); the gateway still reads config protocols 2 and 3.
- The demo application `Syn_Visu_Demo` runs a machine with every component type, a product generator and a sequence
  control for the Simulator (`docs/demo-plc.md`).
- Tests: unit tests at the seams, TcUnit suites for both libraries, browser tests of all three apps against the demo.

## How to run it against the PLC

The demo application on the local user-mode runtime (`docs/demo-plc.md`; the gateway has no simulator, ADR 0020):

1. Open `plc/RPP_Visu.sln` in TwinCAT XAE (4026, user-mode runtime `UmRT_Default`, target `169.254.123.103.1.1`,
   which is this PC).
2. Build, activate the configuration, log in to `Syn_Visu_Demo` and start it. If the manifest looks stale after an
   online change, do a cold reset and start again.
3. `corepack pnpm install`, `corepack pnpm build:bridge`, `corepack pnpm build`
4. `corepack pnpm dev:gateway` (the demo on port 852 through the local router; the library project on 851 has no task)
5. Open http://localhost:8080

## Decisions changed during implementation

The spec in issue #1 is updated to these; the hard-to-reverse ones are ADRs:

- ADS via the .NET bridge instead of `ads-client` (ADR 0001).
- Delta state is TCP only (ADR 0002).
- The manifest `GVL_Visu.stManifest` is declared by the application, not by the library (ADR 0003).
- A third browser message kind `status`; full discovery repeated every second; a rejected product past the belt end is
  hidden instead of flagged as missed.

## Open

- Not yet tried on real hardware: a panel PC (touch, recording and playback, frame rate), a second IPC over an ADS
  route (several sources), performance on an IPC with a real-time core.
- The Syn_Visu copy in the Viersen project is still on protocol 6 (wrappers use IDH C and LUN C) and on the old names;
  RPL6 needs the same migrations (the breaking changes per protocol version are in this file's history). Both have to
  follow every breaking library version.
- `VISU_GlobalConst_Param` is a plain constant GVL, not a library parameter list, so array sizes are not yet
  overridable per project.
- An active recipe saved before a recipe field was appended gives that field 0, not its program value; Syn_Config
  could keep a field count in `ST_ConfigRecipeSet`.
- The trial licence of the user-mode runtime `UmRT_Default` expires on 18 Nov 2026.
- Idea raised but not built: Delta part sizes scaled with the configured geometry.
- Local leftovers from the ADS investigation, not needed any more: `EnableAmsTcpLoopback` in the Windows registry and
  in `UmRT_Default\3.1\TcRegistry.xml`.
