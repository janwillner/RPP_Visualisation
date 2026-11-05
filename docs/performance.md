# Performance with many products

Real machines can hold thousands of products at once. Every product a conveyor register holds costs time at every
stage: the PLC keeps the register, the ADS bridge reads it, the gateway maps it and sends it, the browser checks it,
follows it and draws it. This page explains how to measure that, so changes can be judged by numbers.

The register limit is `VISU_un_MAX_PRODUCTS` = 4800 per conveyor (library 7.1.0).

## Benchmarks: `pnpm bench`

`pnpm bench` runs the benchmarks in `apps/gateway/bench/` and `apps/web/bench/` (Vitest bench) with 500, 2000 and 4800
products on one conveyor:

| Benchmark | What it measures |
| --- | --- |
| gateway cycle | read (from memory), map and publish one state |
| state message to JSON | turning one state message into JSON (once per message, for all browsers) |
| receive a state message | `JSON.parse` and the schema check in the browser |
| product history | following the products of one state message |
| replay buffer | keeping one state message in the replay buffer |
| machine scene | building the scene, once per frame (16.7 ms per frame at 60 Hz for everything) |

Compare runs before and after a change on the same PC. Do not read the absolute numbers as those of the running
system: Vitest starts Node with `--conditions development`, which makes the gateway's mapping about ten times slower
than in the running gateway (about 5 ms instead of 50 ms for 4800 products). The browser numbers come close to what
`tsx` gives. A panel PC is several times slower than a development PC.

Baseline on a development PC (Vitest, mean values, before any of the improvements):

| Products | Gateway cycle | State JSON | Receive | Product history | Replay buffer | Machine scene |
| --- | --- | --- | --- | --- | --- | --- |
| 500 | 5.7 ms | 0.15 ms | 0.7 ms | 0.1 ms | 0.2 ms | 0.9 ms |
| 2000 | 23.5 ms | 0.8 ms | 4.1 ms | 0.9 ms | 1.3 ms | 5.9 ms |
| 4800 | 89.7 ms | 2.4 ms | 10.3 ms | 2.7 ms | 3.6 ms | 18.1 ms |

## Load in the simulator: `--sim-products`

`pnpm dev:gateway -- --sim-products 4000` (or `pnpm start -- --sim-products 4000`) adds a buffer belt at Y = 9000 to
the simulator: ten lanes, a row every 150 mm, as long as needed for that many products (at most `VISU_un_MAX_PRODUCTS`
less a few rows). It is full from the start; a row enters at its start every 0.5 s and leaves beyond its end, and every
25th product is rejected halfway, so the register keeps changing. Without the option the simulator is unchanged.

## Live figures: `/health`

Every source in `GET /health` has `acquisition` once states arrive, over the last 250 snapshots (about 5 s):

- `readMs`: reading every state of the source in one sum-read, including the ADS bridge (average, maximum).
- `mapMs`: mapping what was read to the neutral model.
- `stateBytes`: size of a state message as sent to the browsers; only while a browser is connected.
- `products`: products in all registers of the newest snapshot.
- `duplicateProducts`, `flickeringProducts`, `lastAnomaly`: since the gateway started, register entries whose id
  appeared twice in one snapshot, and products missing from exactly one snapshot. Both should stay 0. Anything else
  means the gateway read a register while the PLC was rearranging it (a register read is not consistent with the PLC
  cycle), which also makes the product history and the metrics count wrongly.

A source whose `readMs` comes close to the cycle (`--cycle-ms`, 20 ms by default) cannot keep up; its snapshots
arrive late.

## Load on the PLC: `P_VisuDemoStress`

The demo application (`plc/Syn_Visu_Demo`) has a stress belt at Y = 11000, off by default. To measure:

1. Log in to the demo (ADS port 852) and write `DEMO_GlobalVar.DEMO_un_StressProducts`, e.g. 4000. The belt joins the
   manifest, fills up within a few seconds and keeps changing like the simulator's buffer belt; every row entering
   rejects one product of the row half a belt ahead (`m_SetProductState` on a full register).
2. Read `P_VisuDemoStress.udn_LastExecTime` and `udn_MaxExecTime` (task execution time in 100 ns, all demo programs)
   and `udn_ExceededCount` (cycles over the task cycle time). `b_ResetMax := TRUE` starts them again. Compare with
   `DEMO_un_StressProducts := 0` (the belt then runs empty but stays in the manifest until the next download).
3. Run the gateway against the demo and watch `/health`: `readMs`, `products`, and above all `duplicateProducts` and
   `flickeringProducts`.

Write down the PLC, the runtime (e.g. 4026 user mode or a real-time core), the task cycle time and the numbers with
every measurement, so measurements on different machines can be compared.
