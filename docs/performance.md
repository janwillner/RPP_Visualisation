# Performance with many products

Real machines can hold thousands of products at once. Every product a conveyor register holds costs time at every
stage: the PLC keeps the register, the ADS bridge reads it, the gateway maps it and sends it, the browser checks it,
follows it and draws it. This page explains how to measure that, so changes can be judged by numbers.

The register limit is `VISU_un_MAX_PRODUCTS` = 4800 per conveyor (library 7.1.0).

## Benchmarks: `pnpm bench`

`pnpm bench` runs the benchmarks in `apps/gateway/bench/` and `apps/visualisation/bench/` (Vitest bench) with 500, 2000 and 4800
products on one conveyor:

| Benchmark | What it measures |
| --- | --- |
| gateway cycle | read (from memory), map and publish one state |
| state message to JSON | turning one state message into JSON (once per message, for all browsers) |
| receive a state message | `JSON.parse` and the schema check in the browser |
| product history | following the products of one state message |
| replay buffer | keeping one state message in the replay buffer |
| machine scene | building the scene, once per frame (16.7 ms per frame at 60 Hz for everything) |
| scene frame | the 3D view taking the scene: what changed and the product groups (`scene-frame.ts`), once per frame |

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

## Measured on a PLC (2026-11-05)

Development PC, TwinCAT 4026 user-mode runtime (not real-time), demo application on port 852 with a 10 ms task and
library 7.1.0, gateway with the ADS bridge at its default 20 ms cycle, one browser stand-in connected (receives, does
not draw). Each stage ran 40 s after the belt had filled; the last row is a 120 s run with the stress belt full. The
other demo belts add about 120 products. Averages and maxima over the last 250 snapshots.

| Stress belt | Products read | PLC task, last / max | Read (`readMs`) | Map (`mapMs`) | State message | States/s | To one browser |
| --- | --- | --- | --- | --- | --- | --- | --- |
| off | 119 | 58 / 209 µs | 5.9 / 19.8 ms | 0.6 / 0.8 ms | 30 KB | 31.6 | 1.0 MB/s |
| 1000 | 1133 | 76 / 243 µs | 11.4 / 22.4 ms | 2.2 / 2.8 ms | 218 KB | 31.7 | 6.9 MB/s |
| 2000 | 2123 | 91 / 444 µs | 15.9 / 31.2 ms | 3.9 / 5.3 ms | 401 KB | 31.0 | 12.1 MB/s |
| 4000 | 4135 | 130 / 927 µs | 23.4 / 38.3 ms | 7.5 / 10.6 ms | 773 KB | 22.5 | 17.4 MB/s |

Over the whole run (about 9000 snapshots, products entering and leaving all the time) the gateway counted no
duplicate and no flickering product, and the PLC task never exceeded its cycle time.

What this says:

- Reading costs time even with few products: about 6 ms for 119 products. Not mainly because of the size, as first
  assumed: every conveyor state is 345 712 bytes (4800 products of 72 bytes), but through the local AMS router a
  sum-read of the 21 demo states takes 2.75 ms whole (3459 KB) and 1.35 ms with only the counted entries (61 KB). Most
  of the time goes into converting the values to JSON in the bridge, passing them to Node and parsing them there.
  See "Reading only the counted entries" below.
- The gateway does not reach its 20 ms cycle: about 32 snapshots per second without load, 22 with 4000 products,
  where reading alone takes longer than a cycle.
- One browser receives 17 MB/s at 4000 products. Sending only what changed (phase 2) is what brings this down.
- The library's cost on the PLC grows with the register: peaks of about 0.9 ms at 4000 products. Not measured per
  method; the likely causes are `m_RemoveProductsBeyond` moving the register up entry by entry and the linear search
  in `m_FindProduct`. Harmless in a 10 ms task, noticeable in a 1 to 2 ms task.
- No register read caught the PLC rearranging a register here. This runtime is not real-time, so check again on an
  IPC with a real-time core; `/health` keeps counting.

## Reading only the counted entries

Since this change the ADS bridge reads a large array that has a count member (`aProducts` with `nProductCount`, also
`aMovers`) only as far as the count of the previous read plus a reserve (a quarter more plus 32 entries), in the same
sum-read as the count itself (`apps/ads-bridge/ReadPlan.cs`). If the count read is larger, the rest follows in a second
sum-read. Arrays below 4 KB and symbols outside plain PLC memory (index groups 0x4020, 0x4040, 0xF020 to 0xF031) are
read whole as before. The bridge keeps each symbol's buffer from read to read.

Checked on the running demo with about 4900 products: old and new bridge read the same structures, and of some 98 000
product entries compared by id only those differed that the application changed between the two reads (products pushed
on the spacing belt, state changes by the robots); also with the reserve set to 0, so that every new product took the
second read.

Gain on the local AMS router, 21 states without the stress belt: the sum-read itself from 2.75 to 1.35 ms; reading and
converting in the bridge from about 3.5 to 3.3 ms. The real gain is for a source on another IPC over an ADS route
(ADR 0005): instead of 3.4 MB per cycle (170 MB/s at a 20 ms cycle, more than gigabit Ethernet carries) about 61 KB go
over the network. Not yet measured with a second IPC.

What remains is converting: with 4000 products the bridge, the pipe to Node and the mapping in the gateway take about
30 ms per cycle, all of it proportional to the products, although almost none of them change from one cycle to the
next. Sending and converting only what changed (phase 2) removes that cost; a faster conversion in the bridge would
only reduce it.

## Sending only the changed products

Since ADR 0013 the web app connects with `/ws?changes=1` and gets each `state` in register form: per conveyor only
the products that changed, plus the ids of the whole register.

| 4000 to 4800 products | Whole states | Register form |
| --- | --- | --- |
| State message (simulator, 4083 products) | 757 KB | 25 KB, most of it the id list |
| To one browser | 17 MB/s (PLC, 4135 products) | 0.9 MB/s (simulator) |
| Receiving in the browser (`pnpm bench`, 4800 products, 4 % changed) | 11.0 ms | 1.2 ms (parse, check, decode) |

The gateway's own cost is unchanged by this: reading and mapping still handle every product in every cycle.

## Reading only the changed products

The bridge compares every register entry's bytes with the previous read by `nId` and converts and passes on only the
changed ones; the gateway maps only those (ADR 0013). Measured on the demo PLC with about 4900 products, two gateways
reading alternately, one through a bridge giving whole registers and one giving changes:

| | Whole registers | Changes |
| --- | --- | --- |
| Read (`readMs`, bridge, pipe, parse) | 24.9 ms (max 50.8) | 3.0 ms (max 6.0) |
| Map (`mapMs`) | 9.1 ms | 0.9 ms |

Over 300 cycles both published the same products; of 1.47 million compared by id, the 1334 that differed were all
changed by the application between the two reads (products pushed on the spacing belt, state changes by the robots).
A gateway cycle with thousands of products now fits well into 20 ms.

## Skipping unchanged products in the browser

The register decoder gives an unchanged product as the same object as in the previous state, and so does the
gateway's mapping. The product history compares a product only when it is another object (it still checks every
product for passing the belt end, since the belt moves it); the register encoder (gateway server, recorder, replay
buffer) and decoder find each product by walking along the previous register in its order instead of building a map
of every product per state, and index a register by id only when its order changed.

`pnpm bench`, 4800 products, one in 25 changed per state, as the browser gets them live (mean per state message):

| | Before | After |
| --- | --- | --- |
| Receive (parse, check, decode) | 0.84 ms | 0.66 ms |
| Product history | 1.90 ms | 0.58 ms |
| Replay buffer | 0.69 ms | 0.45 ms |
| Together | 3.43 ms | 1.69 ms |

## Drawing thousands of products

Every product used to be a mesh of its own with its own geometry, material and edge lines and its own frame callback,
and the scene gave each product five snap points in every frame. Now products on a belt (normal and missed) are drawn
per solid (shape and size) as one instanced mesh with a colour per instance, and their edge lines as one instanced
line set that shares the mesh's instance matrices; placeholders and carried products, which are few, stay single
meshes. React renders again only when a group of products appears or outgrows its room (a power of two), not for every
product that enters or leaves. Product snap points are built only in measure mode.

| 4800 products, per frame (`pnpm bench`) | Before | After |
| --- | --- | --- |
| Build the machine scene | 13.9 ms | 5.9 ms (13.9 ms while measuring) |

In the browser (Edge, RTX 4080 through ANGLE/D3D11, 1280 × 800, simulator with 4000 products on the buffer belt,
already with changes on the WebSocket):

| | Before | After |
| --- | --- | --- |
| Frames per second | 11.8 | about 71 |
| Frame time, 95th percentile | about 100 ms | 20.9 ms |
| Main thread busy with long tasks | 87 % | 0 % |

Screenshots of both versions, also close up, show the same picture. A panel PC has a much weaker GPU and CPU; measure
there before relying on these numbers.

## The register on the PLC (library 7.2.0)

`m_FindProduct` searched the register entry by entry, and `m_LatchProduct`, `m_SetProductState`,
`m_MoveProduct` and `m_RemoveProduct` all call it; removing a product moved the entries behind it one by one, and
`m_RemoveProductsBeyond` copied each entry that stayed. Since library 7.2.0 a conveyor keeps an index from product
id to register entry (`VISU_un_PRODUCT_INDEX_SIZE` slots, 32 KB per conveyor, rebuilt after the register was
rearranged; if it is too small for the register, the search falls back to going through it), and moves entries with
`MEMMOVE`: `m_RemoveProductsBeyond` in runs, usually one, since the products leaving are the oldest at the front.
The contract and the methods' behaviour do not change.

Demo PLC, 10 ms task, 3990 products on the stress belt, task execution time of all demo programs (about 57 µs without
products):

| | 7.1.0 | 7.2.0 |
| --- | --- | --- |
| Mean | 143.5 µs | 86.5 µs |
| Maximum | 899 µs | 395 µs |

Checked through the gateway over 1500 snapshots with 4000 products: the register kept its order, no product was read
twice or went missing, and the state changes that find their product by id (rejections on the stress belt, every
robot state on the other belts) all happened.

## Limit violations (protocol 19)

The TCP limit areas are checked every frame (scene) and for every state message (timeline, also for the replay
buffer). Their cost grows with the robots and movers, not with the products. Measured with `tsx` on a development PC
(mean values; the simulator machine: three robots with a TCP limit area, the IDH with four movers):

| | First version | Now |
| --- | --- | --- |
| Machine scene per frame, extra for the TCP limit areas | 65 µs | 23 µs |
| `limitViolations`, simulator machine | 34 µs | 8 µs |
| `limitViolations`, a machine without TCP limit areas | 3 µs | 0.8 µs |
| `limitViolations`, one gantry with 32 movers (every pair checked) | 630 µs | 32 µs |
| Timeline per state message, extra | 34 µs | 8 µs |

What made the difference: each box is prepared once per frame (`orient`), a pair of boxes whose surrounding spheres
are apart is answered without the separating axis test, the test itself allocates nothing, a machine without TCP
limit areas checks nothing, an offline source computes only the boxes, the track of an XTS gantry or loop is laid out
once per frame instead of once per mover (`trackPoints`, which also helps the scene without TCP limit areas), and the
corners of the TCP limit areas become snap points only in measure mode. A violation that starts or ends re-renders
the 3D view once, like a fault: its label appears or goes.
