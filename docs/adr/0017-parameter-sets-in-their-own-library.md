# Parameter sets live in their own PLC library, Syn_Config

The configurator (ADR 0016) writes a draft to a PLC as the parameters the machine application runs with. Syn_Visu only
describes the machine for the visualisation and is read-only; an application calls its configuration methods every
cycle with its own values. Putting writable parameters into Syn_Visu would make a diagnostics library decide what the
machine does, and make machine logic read its zones from a visualisation library.

So parameter sets live in a library of their own, **Syn_Config** (namespace `SynConfig`). It references Syn_Visu only
for the shared types (pose, zone, product type, areas); Syn_Visu does not know it.

- **Per component a parameter FB** (`_FB_ConfigConveyor`, `_FB_ConfigDelta`, more with #24), registered in its own
  manifest `GVL_Config.stManifest` (declared by the application, as in ADR 0003) with the **id of the Syn_Visu
  component it parametrises**, its type and the symbol path of its `vo_Config`. The manifest has its own protocol
  version (`CONFIG_PROTOCOL_VERSION`). A source without it can be read, not written.
- **The application owns persistence and the moment of taking over.** Every cycle it calls
  `fb_InfeedParam.m_Cycle(vi_Default := …, vio_Param := …, vi_b_ApplyAllowed := …)`: `vi_Default` are its program
  values (what it passes to Syn_Visu today), `vio_Param` its own `VAR PERSISTENT` variable holding the active set,
  `vi_b_ApplyAllowed` when a set may be taken over (e.g. while the machine stands). The effective values are the
  active set while one is valid, else the defaults; the application reads them through getters and passes them on to
  its own logic and to Syn_Visu (`fb_Infeed.m_Configure(vi_Pose := fb_InfeedParam.m_Pose(), …)`).
- **Staging.** The gateway writes a proposed set into `vo_Config.stStaged` and `vo_Config.stStaging` (base version,
  stage id, `bReset`, `bStaged` last) in one ADS sum-write; its sub-commands run in order, so a set is never seen
  staged half written, and no checksum is needed. The FB checks a staged set when allowed (counts within the arrays,
  zones on conveyors the application knows) and takes it over or rejects it with a reason; `stStatus` tells the active
  version, the last stage id handled, the result and its message; `stActive` the effective values. `bReset` makes the
  active set invalid: the program values apply again.
- **The gateway** finds the parameter FBs through the config manifest during discovery, reads their status and
  active values in its cyclic sum-read and sends a `parameters` message per source when they change. It accepts the
  WebSocket commands `writeParameters` and `resetParameters` only when started with `--allow-write`, and only on the
  active version the client based its draft on (optimistic lock). It writes leaf values by path (`sumWrite`), the PLC
  member names following the contract's naming convention; the ADS bridge resolves their types from the symbols.
- **The configurator** compares a component's active parameter set with what the visualisation shows: a difference
  means the application does not pass the parameters on to Syn_Visu, and is a warning.

## Considered Options

- **Parameter sets inside Syn_Visu**, the values of the `m_Set…` methods as defaults overridden by an active set.
  Existing applications would not change, but a visualisation library would decide machine behaviour behind a hidden
  rule, and machine logic would depend on it.
- **Persistence inside the library.** A `VAR PERSISTENT` in an FB makes its whole instance persistent; the
  application's own variable keeps persistence visible and lets a recipe system manage the sets.
- **A checksum over the staged set.** Needs the gateway and the PLC to agree on a byte layout; writing `bStaged` last
  in the same sum-write gives the same guarantee.

## Consequences

- An application that wants the configurator adds Syn_Config, one parameter FB, one persistent variable and one
  `m_Cycle` call per component, and passes the effective values on; without it nothing changes.
- First version (#23): conveyor (pose, origin shift, product types) and Delta (pose, origin shift, zones, working,
  limit and TCP limit area). Hardware (lengths, arm geometry) is never written (ADR 0016).
- Two libraries with their own versions; Syn_Config names the Syn_Visu version it needs.
