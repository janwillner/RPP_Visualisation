# Performance with many products

Real machines hold thousands of products at once, and every product a register holds costs time at every stage: the
PLC keeps the register, the ADS bridge reads it, the gateway maps and sends it, the browser checks, follows and draws
it. This page says how to measure that, so a change can be judged by numbers, and what has been gained so far. The
register limit is `VISU_un_MAX_PRODUCTS` = 4800 per conveyor.

## Benchmarks: `pnpm bench`

Vitest benchmarks in `apps/gateway/bench/` and `apps/visualisation/bench/` with 500, 2000 and 4800 products on one
conveyor: gateway cycle, state message to JSON, receiving a state message, product history, replay buffer, machine
scene (once per frame: 16.7 ms per frame at 60 Hz for everything) and scene frame (`scene-frame.ts`).

Compare runs before and after a change on the same PC. The absolute numbers are not those of the running system:
Vitest starts Node with `--conditions development`, which makes the gateway's mapping about ten times slower than in
the running gateway; the browser numbers come close to `tsx`. A panel PC is several times slower than a development PC.

## Live figures: `/health`

Every source in `GET /health` has `acquisition` once states arrive, over the last 250 snapshots (about 5 s):

- `readMs`: reading every state in one sum-read, bridge included (average, maximum); `mapMs`: mapping it.
- `stateBytes`: size of a state message as sent to the browsers (only while one is connected); `products`.
- `duplicateProducts`, `flickeringProducts`, `lastAnomaly`: register entries whose id appeared twice in one snapshot,
  and products missing from exactly one snapshot, since the gateway started. Both should stay 0; anything else means a
  register was read while the PLC rearranged it, which also makes the history and the metrics count wrongly.

A source whose `readMs` comes close to the cycle (`--cycle-ms`, 20 ms by default) cannot keep up.

## Load on the PLC: `P_VisuDemoStress`

The demo has a stress belt at Y = 11000, off by default:

1. Log in to the demo (port 852) and write `DEMO_GlobalVar.DEMO_un_StressProducts`, e.g. 4000. The belt joins the
   manifest, fills within seconds and keeps changing (each new row rejects a product half a belt ahead).
2. Read `P_VisuDemoStress.udn_LastExecTime` and `udn_MaxExecTime` (task execution time in 100 ns) and
   `udn_ExceededCount`; `b_ResetMax := TRUE` restarts them. Compare with `DEMO_un_StressProducts := 0`.
3. Run the gateway against the demo and watch `/health`, above all `duplicateProducts` and `flickeringProducts`.

Write down the PLC, the runtime (user mode or real-time core), the task cycle time and the numbers with every
measurement.

## Where the time goes (measured 2026-11-05, before the optimisations below)

Development PC, 4026 user-mode runtime, 10 ms task, gateway at 20 ms, one browser stand-in, 4000 products on the
stress belt: reading 23.4 ms, mapping 7.5 ms, a state message 773 KB, 22.5 states/s, 17.4 MB/s to one browser, PLC task
peaks of 0.9 ms. Through the local AMS router the sum-read itself was cheap (2.75 ms for 21 whole states); most of the
time went into converting values to JSON in the bridge, passing them to Node and parsing them. No duplicate or
flickering product in about 9000 snapshots; check again on an IPC with a real-time core.

## Gained so far

| Change | Measured (4000 to 4900 products unless said) | Before | After |
| --- | --- | --- | --- |
| Bridge reads only the counted entries plus a reserve (`ReadPlan.cs`) | sum-read, 21 states | 2.75 ms | 1.35 ms |
| | over an ADS route per cycle | 3.4 MB | 61 KB |
| States to the browser as changes (ADR 0013) | to one browser | 17 MB/s | 0.9 MB/s |
| | receiving in the browser (4800, 4 % changed) | 11.0 ms | 1.2 ms |
| Bridge converts and gateway maps only changed entries | `readMs` | 24.9 ms | 3.0 ms |
| | `mapMs` | 9.1 ms | 0.9 ms |
| Browser skips unchanged products (same object) | receive + history + replay buffer per state | 3.43 ms | 1.69 ms |
| Products drawn as instanced meshes per solid | machine scene per frame (4800) | 13.9 ms | 5.9 ms |
| | frames per second (Edge, RTX 4080, 4000 products) | 11.8 | about 71 |
| Register index by id and `MEMMOVE` (Syn_Visu 7.2.0) | PLC task mean / max (3990 products) | 144 / 899 µs | 87 / 395 µs |
| TCP limit areas: `orient` once, sphere test first | `limitViolations`, gantry with 32 movers | 630 µs | 32 µs |

Notes on these:

- The bridge keeps each symbol's buffer from read to read; arrays below 4 KB and symbols outside plain PLC memory are
  read whole. A count larger than the reserve is read in a second sum-read.
- Unchanged products stay the same object from the decoder and the gateway's mapping; the history and the encoders
  rely on that (never mutate a product).
- React re-renders the products only when a group appears or outgrows its room (a power of two); product snap points
  and TCP-limit-area corners exist only in measure mode. A panel PC has a much weaker GPU: measure there before
  relying on the frame rate.
- A machine without TCP limit areas checks nothing; an offline source only computes the boxes.
- Not yet measured: a second IPC over an ADS route, a panel PC, an IPC with a real-time core.
