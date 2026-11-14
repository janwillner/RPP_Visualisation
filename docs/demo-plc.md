# The demo application

`pnpm dev:gateway` and the browser tests (`pnpm test:e2e`) read the demo application `Syn_Visu_Demo`
(`plc/Syn_Visu_Demo`, ADS port 852) on the local TwinCAT user-mode runtime (ADR 0020). `pnpm test` needs none of
this: the gateway tests use an in-memory PLC.

## Running it

1. Open `plc/RPP_Visu.sln` in TwinCAT XAE 4026. Its target is the user-mode runtime `UmRT_Default` on this PC, which
   needs a TC1200 licence (a 7-day trial licence will do).
2. Build the solution, activate the configuration (TwinCAT restarts in Run mode), log in to `Syn_Visu_Demo` with a
   download and start it. If the manifest looks stale after an online change, reset it cold and start it again.
3. `pnpm build:bridge` once: the gateway reads the PLC through the ADS bridge.
4. `pnpm dev:gateway` (port 8080, writing allowed) or `pnpm test:e2e`.

The gateway reaches the demo through the local AMS router, AmsNetId `127.0.0.1.1.1`. The browser tests take
`E2E_AMS_NET_ID` and `E2E_ADS_PORT` to read another runtime, `E2E_PORT` for the gateway's own port (8090).

## The machine and its recipe

`P_VisuDemoMachine` is the demo's minimal sequence control of Infeed 1 and Delta 1 (ADR 0022): a recipe of 16 fields
(belt, robot, product pattern of the generator before Vision 1, seed; the pattern Scattered shows only the scatter
fields, Lanes only the lane fields, and every field has a description), Start, Stop and Reset through Syn_Config's
machine FB, the run state and the machine messages "Reject bin almost full" and "Product missed" through Syn_Visu. It
starts running with the program values, which give the product pattern the demo had before its recipe (one lane, 60
products a minute, every type, scattered), though not the same products: the generator draws its own random numbers
and Infeed 1 ramps up from standstill after every download. The browser tests rely only on such a pattern, not on
particular products. The active recipe is persistent: a test that stops the machine or writes a recipe has to return
the recipe to its program values and start the machine again. Rate counts the generator's places a minute at the
recipe's belt speed, so the pattern keeps its spacing while the belt ramps or stands; Reset (while stopped) also
acknowledges Delta 1's periodic fault until its next fault period.

## What the browser tests rely on

The demo runs these all the time; none of them needs a trigger.

| Scenario | Where in the demo |
| --- | --- |
| A fault for 5 s every 20 s on a component, a mover or a track module | `DEMO_lr_FAULT_PERIOD`, `DEMO_lr_FAULT_DURATION`, each application's faults |
| Limit violations: the Deltas' TCP limit areas leave their limit areas now and then, several times a minute | `P_VisuDemoDelta` |
| A product mark: Vision 1 marks every tenth product on Infeed 1 as "Sample", kept on the outfeed | `P_VisuDemoDelta` |
| Rejects at the reject unit, missed products at the belt ends | `P_VisuDemoDelta`, `P_VisuDemoFxx`, `P_VisuDemoIdh` |
| Parameter sets to write: Infeed 1, Vision 1, Delta 1 (a zone) and the IDH (its track) | `P_VisuDemoDelta`, `P_VisuDemoIdh` |

The demo keeps a written parameter set. A browser test that writes one returns the component to its program values at
its end, and at its start in case an earlier run stopped halfway, so every run starts from the program values.

Load tests with thousands of products: `DEMO_un_StressProducts` (`P_VisuDemoStress`, `docs/performance.md`).
