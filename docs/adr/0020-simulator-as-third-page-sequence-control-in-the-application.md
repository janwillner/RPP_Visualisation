# The Simulator is a third page; the product generator and sequence control stay in the application

Commissioning engineers want to exercise an application's sequence control before the real machine exists: feed
products in patterns, try the process values a machine runs with (belt and robot speeds, picks per cycle, the product
pattern) and start, stop and reset a test run (spec #40). That tool is the **Simulator**, a third web app next to the
visualisation and the configurator (ADR 0019), served at `/simulator/`.

Until now "simulator" named something else: an `InMemoryPlc` preset in the gateway (`--driver sim`, the default) that
changed invented values every cycle, so the web apps and their browser tests ran without a PLC. It ran no real sequence
control, it duplicated what the demo application `Syn_Visu_Demo` already does in ST (the same lines, faults, samples,
rejects, missed products and limit violations), and it occupied the name the engineer would use for the new tool.

So:

- **The gateway has no fake PLC.** The simulator preset, `--driver sim` and `--sim-products` are gone; the default
  driver is `ads`. `InMemoryPlc`, the PLC builders and the Syn_Config emulation stay as the gateway tests' helpers; the
  tests that needed a whole machine (docs page, web pages, WebSocket commands) build one fixed fixture with one
  component of every type. `pnpm test` still runs without TwinCAT.
- **The browser tests and `pnpm dev:gateway` read the demo application** on the local TwinCAT user-mode runtime
  (local AMS router, ADS port 852; `E2E_AMS_NET_ID`, `E2E_ADS_PORT` to change it, `docs/demo-plc.md`). The demo
  provides every scenario they check, continuously: a fault every 20 s, samples marked by Vision 1, rejects, missed
  products, limit violations, and parameter sets of Delta 1 and the IDH to write. A browser test that writes a
  parameter set returns it to the program values at its end, since the demo keeps it.
- **The product generator and the sequence control stay in the application.** Both depend on the machine (its camera
  or sensor, its tracking, its robots), so no library ships them; the Simulator only sets the application's recipe
  fields and sends Start, Stop and Reset requests, which the application acknowledges or rejects (ADRs to follow with
  #42 and #43). This repo has one generator and one minimal sequence control, in the demo application only.

## Considered options

- **Keep the in-memory simulator for the browser tests** and use the demo only for the new page: the tests would keep
  running without TwinCAT, but two machines would have to show every scenario and stay alike, and the browser tests
  would never cover reading a real PLC through the ADS bridge.
- **A product generator in Syn_Visu or Syn_Config**: every application would get the same pattern, but a real
  application's tracking expects detections the way its own camera or sensor reports them, which a library cannot
  know.

## Consequences

- `pnpm test:e2e` needs TwinCAT XAE with the demo running on the user-mode runtime; it cannot run on a build server
  without one (the Release workflow runs only `pnpm test`).
- Load tests with thousands of products use the demo's `P_VisuDemoStress` (`DEMO_un_StressProducts`) or the
  benchmarks, not a simulator option.
- A source no longer has the id `sim`; every source is `ads:<AmsNetId>:<port>`.
