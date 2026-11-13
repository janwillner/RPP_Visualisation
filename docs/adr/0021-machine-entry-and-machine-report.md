# The machine entry: run state and machine messages next to the manifest, published as their own message

The Simulator (ADR 0020) needs to know what the machine is doing and whether its application runs without real
hardware, and the commissioning engineer and the operator need the application's own diagnosis, not only the faults of
its parts. A fault belongs to a component, a mover or a track module, has no severity and no time, and is there only
while it lasts. What was missing is the machine as a whole: its **run state** (stopped, starting, running, stopping,
fault, with a text), **simulation mode**, and **machine messages** the application raises and clears, each with a
severity, a number, a text, the time it appeared and, optionally, the component it is about (spec #40, issue #42).

So:

- **In the PLC, a machine entry next to the manifest**, not a component: `GVL_Visu.stMachine : ST_VisuMachine`,
  declared by the application like its manifest (ADR 0003), in the same GVL (the gateway derives its path from
  `--manifest-path`). The machine has no pose, no body and no manifest entry. Its messages are a register like a
  product register (array plus count, read as changes by `nId`, ADR 0013), at most `VISU_un_MAX_MACHINE_MESSAGES` (32)
  active and gone. `_FB_VisuMachine` fills it every cycle: `m_SetRunState`, `m_SetSimulation` and `m_SetMessage`, which
  sets a message by its level like `m_SetFault`; a message that becomes active gets the current DC time, a gone one
  stays listed until a new one needs its place. Protocol 22, Syn_Visu 9.7.0.
- **Optional for the application, and protocol 21 still read.** The entry only adds to the contract, so the gateway
  reads protocol 21 and 22 (`MIN_PROTOCOL_VERSION`), and with 22 it looks for the entry during discovery: an
  application without it is read as before, one of another type is a discovery error. Machine projects can take the new
  library without code changes and the new gateway without a new library.
- **On the wire, a message of its own:** `machine`, per source, with `runState`, `runStateText`, `simulation` and
  `messages`, sent when it changes and to every new client after `status` and `config`. Clients switch on `kind` and
  ignore kinds they do not know (`docs/api.md`), so one that does not care loses nothing.
- **In the web app, part of what it knows about a source:** `Sources` folds the report into the source's
  `SourceInfo.machine`. Recordings and the replay buffer keep every block's `SourceInfo` as its context, so the machine
  is known at every moment of a playback without anything of its own; a recording file's header carries it. A machine
  message appearing (becoming active, or active again with a new time) is a timeline event.

## Considered Options

- **Part of `state`**: every snapshot would carry the run state and the whole message register, 50 times a second,
  although it changes a few times a minute; the register form (ADR 0013) would have to learn a second kind of register.
  A state is about the components' motion; the machine's diagnosis is not interpolated.
- **Part of `status`**: `status` says whether the gateway reads the PLC, and it is the gateway's own; the run state
  comes from the application. A source that goes offline would lose its last report.
- **A machine component** in the manifest: it would need a pose and a body, every kit and list would have to skip it,
  and the configurator would offer it.

## Consequences

- Recordings of protocol 21 still play (they hold no `machine`); a recording with machine reports needs this version.
- The Simulator (#45) takes the run state and simulation mode from `SourceInfo.machine` to enable its commands, and the
  gateway refuses writes while `simulation` is false (#43).
