# One gateway reads several PLCs and merges them into one scene

This amends ADR 0004, which planned one service per PLC runtime and rejected reading other IPCs over ADS routes. A machine may be split over several IPCs, for example the infeed with its Delta robots on one IPC and the XTS outfeed on another. One gateway instance therefore reads a list of PLC sources. A source is an AmsNetId plus an ADS port, and each source has its own manifest. The web app shows all of them in one scene. The gateway runs on an IPC with TwinCAT and reaches the other IPCs through the local AMS router, over ADS routes that the commissioning engineer sets up in TwinCAT. The app never creates routes and holds no credentials, so it stays read-only.

All sources report in the same MCS, and the PLC contract is unchanged. Manifest ids are unique only within one source: gateway messages, selection and hiding identify a component by source id plus manifest id. References such as a zone's conveyor, a product's robot or a gripped mover stay within one PLC. A product that moves from one PLC's component to another's leaves one register and enters the other.

Each source runs its own discovery, config recheck and acquisition loop with its own ADS bridge process, and waits 5 s after a failed attempt. A slow or unreachable IPC never holds up the others. The web app buffers and interpolates each source on its own timeline, because the IPCs' clocks are not synchronised. The components of an unreachable source stay in the scene with their last state, faded, and the status names the source.

## Considered Options

- **One gateway instance per PLC, each in its own view.** This already worked before through configuration. It cannot show a machine spread over several IPCs as one machine. It remains possible for separate machines.
- **The app creates the ADS routes.** It would need a user name and password for every target IPC and would have to store them. A route is a one-time commissioning step in TwinCAT.
- **Ids unique across all PLCs, set in the PLC projects.** This would keep the web model unchanged, but every IPC team would have to agree on id ranges, which tends to go wrong during commissioning.
- **One bridge process with one ADS client per source.** This saves a few processes, but a hanging connection could block every source.
- **A shared time axis across sources.** It would need DC/NTP time synchronisation between the IPCs. A few milliseconds of offset do not matter for a visualisation.

## Consequences

- `status`, `config` and `state` messages carry a `sourceId`, and `status` also carries the source's display name. The web app merges the sources; the gateway does not.
- Several sources work only with the `ads` driver. `ads-tcp` and the simulator read one source.
- Placing a source's components with an offset per source is not supported. Add it only when a PLC cannot report in the machine's MCS.
