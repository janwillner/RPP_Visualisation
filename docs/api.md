# RPP visualisation API

The RPP visualisation shows packaging machines in 3D, read-only, built from what their PLCs report. Its server, the
gateway, reads one or more PLCs over ADS and passes on what it reads. This API lets your own programs receive the same
data: an MES, a dashboard, a logger, a test tool. It is read-only: nothing you send reaches a PLC.

This document is in the source repository only. The page the gateway serves at `/docs` is the guide for PLC
programmers (ADR 0014). For programs, every server describes the protocol it runs as JSON Schema at
`/docs/schema.json` (e.g. `http://<ipc>:8080/docs/schema.json`), generated from its protocol schemas with a
description of every field.

## Overview

One HTTP port (8080 by default) serves:

| Endpoint                | What it is                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `ws://<host>:<port>/ws` | WebSocket with the machine data: `status`, `config` and `state` messages as JSON.               |
| `GET /health`           | Health of every PLC as JSON, for monitoring: 200 while all are connected, else 503.             |
| `GET /docs`             | The guide to the PLC library `Syn_Visu`, for PLC programmers.                                   |
| `GET /docs/schema.json` | JSON Schema of the messages, the health report and the recording file lines.                   |
| `GET /`                 | The visualisation.                                                                              |
| `GET /configurator/`    | The configurator.                                                                               |

There is no authentication. Anyone who can reach the port can read the data, so keep the port inside the machine
network.

## Concepts

**Source.** A PLC runtime the gateway reads, named by `sourceId` as `ads:<AmsNetId>:<port>`, e.g.
`ads:5.80.201.232.1.1:851`. One gateway may read several sources. Every message names its
source, and everything you keep should be keyed by it.

**Component.** One part of the machine the PLC registers: a conveyor, a Delta robot, an XTS gantry, an XTS loop, a
Cartesian robot, a vision system, a product sensor or a station. Its `id` comes from the PLC's manifest and is unique
**only within its source**; `(sourceId, id)` identifies a component.

**Config and state.** What a component *is* (its type, size, pose, zones, product types) comes once in a `config`
message. What it *does* (belt position, products, robot axes, faults) comes in every `state` message, about every
20 ms. A state belongs to the config with the same `configVersion`.

**Coordinates and units.** Every value is in millimetres and degrees, in the MCS (machine coordinate system):
right-handed, Z up, X in the product flow direction. A component's `pose` places its local frame in the MCS; the
field descriptions in `/docs/schema.json` say which frame each value is in.

**Time.** `state.timestamp` and every component's `timestamp` are PLC times (EtherCAT distributed clock, ns, as decimal
strings, since they exceed the precision of a JSON number). `state.tRel` is the same time in milliseconds since the
gateway connected to that PLC, as a plain number: use it to interpolate between snapshots. It starts again from 0 after
every reconnect.

## The WebSocket

Connect to `ws://<host>:<port>/ws` (`wss` is not offered). The server sends; the only thing it takes from a client are
the commands on parameter sets (see "Parameter sets" below), and it ignores anything else.

Right after you connect, you get for every source:

1. a `status` message: is the PLC connected?
2. its current `config`, if the gateway has discovered that PLC;
3. its `machine` report, if its application has the machine entry.

After that, the server sends:

- a `state` for every source in every acquisition cycle (20 ms by default, `--cycle-ms`) while its PLC is connected;
- a `status` whenever a PLC connects or drops out. After a drop-out, the gateway tries again every 5 s;
- a new `config` when the PLC's configuration changes (a new `configVersion`), and after every reconnect;
- a `machine` report when the machine's run state, simulation mode or messages change (protocol 22).

Messages of one source arrive in order: a new `config` comes before the first `state` that belongs to it.

**Slow clients.** If a client cannot keep up and the server has more than about 1 MB queued for it, the server drops
`state` messages for that client until it catches up. `status` and `config` messages are never dropped. A client
therefore must not assume it sees every snapshot; each `state` is complete on its own (in register form, see "Only
what changed", the server sends every product after a dropped one).

**Handling messages.** A client typically does this:

- Switch on `kind`; ignore kinds you do not know.
- On `config`: check `protocolVersion` (see below), then store the config per `sourceId`, replacing the old one. Report
  `errors`: they name PLC entries that were left out.
- On `state`: look up the config of its `sourceId`. If there is none, or its `configVersion` differs, skip the state.
  Otherwise match each `components[i]` to its config by `id`.
- On `status`: show the source as offline while `status.plcConnected` is false. Keep its last config to show what was
  there.
- On `machine`: keep it per `sourceId`, replacing the old one (see "The machine" below). Drop it with every new
  `config` of that source: the server sends the report again right after, unless the application no longer has one.
- On close: connect again after a short wait. The server sends status, config and the machine report again.

**Products.** A conveyor's `products` is its product register. A product's position is given at its latch (the moment a
detector saw it) and moves with the belt. While it lies on the belt, its X in the conveyor's coordinate system is
`latchPose.x + beltPosition − latchBeltPosition`. The conveyor's coordinate system is its `pose` moved by its
`originShift`, with X along the belt. `state`, `previousState` and `lastClientId` tell what happened to it last and who
did it. While a product is `picked`, it hangs at the gripper finger `fingerId` (or the flange) of robot `lastClientId`.
A product the PLC singled out has a `mark` (1 to 4, 0 = none); the config's `marks` say what each named mark means
for the whole source, e.g. `{ "id": 1, "name": "Sample" }`. The visualisation draws a marked product in its mark's
colour instead of its state colour.

**Only what changed.** A register can hold thousands of products, and a `state` is sent every 20 ms, but only a few
products change from one state to the next. Connect to `/ws?changes=1` to get states in register form: each `state`
has `registers`, per conveyor id the ids of its whole register in order, and that conveyor's `products` hold only the
products that changed since the previous `state` of the same source. Keep the products of the previous state per
source and conveyor, and build the register in the order of `registers`, taking each product from `products` if it is
there and from the previous state otherwise. The first `state` of each source after connecting lists every product, and
so does the next `state` after the server dropped one for a slow client, so a client never has to ask again. Without
`?changes=1` every `state` is whole, as described above. The web app connects with `?changes=1`; ADR 0013 explains the
choice.

**The machine.** Since protocol 22 an application may report its whole machine (ADR 0021): a `machine` message per
source with `runState` (`stopped`, `starting`, `running`, `stopping`, `fault`) and its `runStateText`,
`simulation` (it runs without real hardware) and `messages`, its machine messages. Each message has the application's
`id`, a `severity` (`error`, `warning`, `info`), a `text`, the PLC `time` it appeared (DC time like a timestamp), a
`componentId` (0 for the whole machine) and `active`: a gone message (`active` false) stays listed for a while. A
source whose application has no machine entry sends no `machine` message; one is never sent between two `state`s for
nothing, only when something in it changed.

## Parameter sets

A PLC whose application uses the library Syn_Config (ADR 0017) lets the configurator write parameter sets: the part of
a component's configuration its application runs with (a conveyor's pose and product types, a Delta's zones and areas).

- **`parameters`** (server → client): per source with Syn_Config, sent after discovery, whenever a status or an active
  set changes, and right after connecting. Per parameter FB: the component `id`, `activeVersion` (0 while the
  application's program values apply), the `handledStageId` and `result` of the last write (`pending` while the
  application does not allow taking it over), a rejection's `message` and the effective values in `set`. `writable`
  is false (with a `reason`) unless the gateway was started with `--allow-write`.
- **`writeParameters`** and **`resetParameters`** (client → server): stage a set on one component, or return it to its
  program values. A browser page of another origin than the gateway's is answered with an error: only the gateway's
  own pages (and clients without an Origin header, such as scripts) may write. `baseVersion` must be the component's `activeVersion`, else the command is refused (someone else
  wrote in between). `requestId` is the client's own.
- **`writeResult`** (server → that client only): `ok` with the `stageId` of the write, or `error`. Whether the PLC
  took the set over follows in `parameters`, once its `handledStageId` is that stage id.

A PLC whose application has Syn_Config's machine FB (config protocol 3, ADR 0022) also has a **recipe**: the process
values its application declares (belt speed, picks per cycle, the product pattern, ...). Then `parameters` carries
`recipe` (its `fields` with name, `group` (component id, 0 = the machine), `type` (`number`, `integer`, `switch`,
`choice`), unit, min, max, program value and choices; the status like a parameter FB's; the effective `values` by field
name) and `machineCommand` (the application's answer to the last command).

- **`writeRecipe`** (`baseVersion`, `values` by field name; a field left out keeps its value) and **`resetRecipe`**:
  stage a recipe or return to the program values, answered with `writeResult` like a parameter set.
- **`machineCommand`** (`command`: `start`, `stop` or `reset`): a request the application accepts or rejects; the
  `writeResult`'s `stageId` is the command id, which `machineCommand.handledCommandId` names once answered. A command
  sent while an earlier one still waits replaces it: only the last one is answered.

All three are refused without `--allow-write`, from a page of another origin, while the PLC is not in simulation mode
(`machine.simulation`), without a machine FB or with config protocol 2, on another active recipe version, and for an
unknown field or a value of the wrong type or outside its range.

A client that only shows the machine can ignore all of these.

## Compatibility

- **Ignore what you do not know.** New fields may appear in any message and in any object, and new values of `kind` and
  of a component's `type` may appear. A client must ignore them and not fail. The JSON Schema therefore allows extra
  properties.
- **The protocol version changes with every change of meaning.** When a field is removed, renamed or changes its
  meaning, `PROTOCOL_VERSION` goes up. `config.protocolVersion` and `/health`'s `protocolVersion` report it.
- **Check the version.** Before you read a `config`, compare its `protocolVersion` with the version your client was
  written for. If they differ, tell the user rather than show wrong data. `/docs/schema.json` always describes the
  version the server runs.

## Example clients

Each example connects, keeps the configs per source, reads states only for the matching config, and connects again
after the connection closes. They print the belt position and the number of products of every conveyor once a second.

### JavaScript (browser, or Node 22 and newer)

Browsers and Node 22+ have `WebSocket` built in.

```js
const url = "ws://localhost:8080/ws";
const PROTOCOL_VERSION = 14; // the version this client was written for
const configs = new Map(); // sourceId -> config message
let lastPrint = 0;

function connect() {
  const ws = new WebSocket(url);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.kind) {
      case "status":
        console.log(`${msg.sourceName}: ${msg.status.plcConnected ? "connected" : "offline"}`);
        break;
      case "config":
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          console.warn(`${msg.sourceId} speaks protocol ${msg.protocolVersion}, expected ${PROTOCOL_VERSION}`);
          configs.delete(msg.sourceId);
          break;
        }
        for (const e of msg.errors) console.warn(`${msg.sourceId}: ${e.path ?? ""} ${e.message}`);
        configs.set(msg.sourceId, msg);
        break;
      case "state": {
        const config = configs.get(msg.sourceId);
        if (!config || config.configVersion !== msg.configVersion) break;
        if (Date.now() - lastPrint < 1000) break;
        lastPrint = Date.now();
        for (const c of msg.components) {
          if (c.type !== "conveyor") continue;
          const name = config.components.find((k) => k.id === c.id)?.name;
          console.log(`${name}: belt ${c.beltPosition.toFixed(0)} mm, ${c.products.length} products`);
        }
        break;
      }
      // other kinds: ignore
    }
  };
  ws.onclose = () => setTimeout(connect, 2000);
}

connect();
```

On older Node versions, install the `ws` package and add `import WebSocket from "ws";`.

### Python

Needs the `websockets` package (`pip install websockets`).

```python
import asyncio
import json
import time

import websockets

URL = "ws://localhost:8080/ws"
PROTOCOL_VERSION = 14  # the version this client was written for


async def main():
    configs = {}  # sourceId -> config message
    last_print = 0.0
    while True:
        try:
            async with websockets.connect(URL, max_size=None) as ws:
                async for raw in ws:
                    msg = json.loads(raw)
                    kind = msg.get("kind")
                    if kind == "status":
                        state = "connected" if msg["status"]["plcConnected"] else "offline"
                        print(f"{msg['sourceName']}: {state}")
                    elif kind == "config":
                        if msg["protocolVersion"] != PROTOCOL_VERSION:
                            print(f"{msg['sourceId']} speaks protocol {msg['protocolVersion']}")
                            configs.pop(msg["sourceId"], None)
                            continue
                        for e in msg["errors"]:
                            print(f"{msg['sourceId']}: {e.get('path', '')} {e['message']}")
                        configs[msg["sourceId"]] = msg
                    elif kind == "state":
                        config = configs.get(msg["sourceId"])
                        if not config or config["configVersion"] != msg["configVersion"]:
                            continue
                        if time.monotonic() - last_print < 1:
                            continue
                        last_print = time.monotonic()
                        names = {c["id"]: c["name"] for c in config["components"]}
                        for c in msg["components"]:
                            if c["type"] == "conveyor":
                                print(f"{names.get(c['id'])}: belt {c['beltPosition']:.0f} mm, "
                                      f"{len(c['products'])} products")
                    # other kinds: ignore
        except (OSError, websockets.ConnectionClosed):
            await asyncio.sleep(2)


asyncio.run(main())
```

`max_size=None` matters: a `config` or `state` of a large machine can exceed the library's default limit of 1 MB.

## Monitoring with /health

`GET /health` answers with a `HealthReport`: the release, the protocol version and, per source, whether its PLC is
connected, the last error, the time of the newest state and the PLC library's version. Once states arrive, each source
also has `acquisition`: how long reading and mapping took and how large a state message is over the last snapshots,
the products in its registers, and products read twice or missing from one snapshot (see `docs/performance.md`). The
HTTP status is 200 while every source is connected, else 503, so a plain HTTP check works:

```sh
curl -fsS http://localhost:8080/health
```

```powershell
Invoke-RestMethod http://localhost:8080/health
```

## Recording files

The web app can record what it receives and save it as a `.rpprec` file. Other programs can read such a file:

- The file is gzip-compressed UTF-8 text with one JSON object per line.
- The first line is the header (`RecordingFileHeader`). Its `format` is `rpp-recording`. `formatVersion` (currently 1)
  is the version of this layout, and `protocolVersion` the version of the messages in the file. `sources` holds every
  source as it was when the recording started, with its last status, config and machine report.
- Every other line is a `RecordingEntry`: a gateway message as described above, with `at`, its arrival time in ms after
  the start.
- To keep files small, a `state` holds per conveyor only the products that changed since that conveyor's previous
  state in the file. `registers` lists, per conveyor id, the ids of the whole register in order. To restore the full
  register, keep the products of each conveyor's previous state by id, update them with the ones in the line, and take
  them in the order of `registers`.

```python
import gzip
import json

with gzip.open("rpp-recording-20260101-120000.rpprec", "rt", encoding="utf-8") as f:
    header = json.loads(f.readline())
    assert header["format"] == "rpp-recording" and header["formatVersion"] == 1
    previous = {}  # (sourceId, conveyor id) -> {product id: product}
    for line in f:
        entry = json.loads(line)
        msg = entry["message"]
        if msg["kind"] == "state":
            for c in msg["components"]:
                order = entry.get("registers", {}).get(str(c["id"]))
                if c["type"] != "conveyor" or order is None:
                    continue
                key = (msg["sourceId"], c["id"])
                known = {**previous.get(key, {}), **{p["id"]: p for p in c["products"]}}
                c["products"] = [known[i] for i in order]
                previous[key] = {p["id"]: p for p in c["products"]}
        print(entry["at"], msg["kind"])
```

## Protocol versions

The current version is `protocolVersion` in `/health` and in every `config`. The latest changes:

| Version | Change                                                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------- |
| 22      | The machine's run state, simulation mode and machine messages: the `machine` message. A PLC of protocol 21 is still read; it sends no `machine`. ADR 0021. |
| 21      | Products may carry a `mark`; the config names the marks (`marks`).                                                      |
| 20      | Gripper fingers have an `offset` on the flange; a finger state says whether its pose is reported (`poseReported`). ADR 0018. |
| 19      | Deltas, XTS gantries and Cartesian robots may have a `tcpLimitArea`, a box around the TCP. ADR 0015.                      |
| 18      | XTS gantries and Cartesian robots may have a `limitArea`, like the Delta.                                                  |
| 17      | Cartesian robots say which axes they have: `axes` (`xyz`, `xz`, `xy`).                                                     |
| 16      | A conveyor may have no body: `body`.                                                                                       |
| 15      | A zone may cover only a lane of its belt: `startY`, `endY`.                                                                |
| 14      | A product's `latchPose` is given in its conveyor's coordinate system (its pose plus origin shift, X along the belt). ADR 0010. |
| 13      | Products name their last client and their state before that change: `lastClientId`, `previousState`. ADR 0009.            |
| 12      | XTS gantries and loops describe their track as a chain of motor modules (`modules`), each with its own fault. ADR 0008.   |

The ADRs (architecture decision records) are in the source repository under `docs/adr/`. The gateway accepts PLCs that
report its own protocol version or, where the newer one only adds something, the one before (22 reads 21: such a
source sends no `machine`). `config.protocolVersion` is the version that PLC reports.

## The PLC side

What the PLC has to provide, so that the gateway finds and reads it, is described in the
[PLC contract](plc-contract.md) (the structures of the library `Syn_Visu`) and in the
[PLC library guide](plc-library-guide.md) for PLC programmers, which the gateway serves at `/docs`.
