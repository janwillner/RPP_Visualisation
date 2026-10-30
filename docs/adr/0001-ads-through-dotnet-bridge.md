# ADS access through a .NET bridge process

The gateway reads the PLC through `apps/ads-bridge`, a small .NET process using Beckhoff's official `TwinCAT.Ads` library, which the Node gateway spawns and talks to over stdin/stdout. The original plan was a pure TypeScript stack with the community TCP client `ads-client`, but on TwinCAT 4026 with the user-mode runtime its router rejects `ads-client` on the same machine: there is no AMS TCP loopback, and a static route would be needed on every machine. The official library registers with the local AMS router like any TwinCAT application, so it works with no router configuration. We accepted a second runtime (.NET 9) on the IPC in exchange.

## Considered Options

- `ads-client` plus a static route or AMS TCP loopback per machine. Rejected: manual router configuration on every IPC, and the loopback setting had no effect on the 4026 user-mode runtime.
- Rewriting the whole gateway in .NET. Rejected: we would lose the protocol types shared with the web app.

## Consequences

- `ads-client` stays available as `--driver ads-tcp` for reading a PLC from another computer that has a route anyway.
- The bridge converts raw PLC memory to JSON from the symbol's type information; 64-bit integers are sent as decimal strings.
