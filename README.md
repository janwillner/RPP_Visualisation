# RPP Visualisation

A web-based 3D visualisation of packaging machines that configures itself from what the PLC reports.

Commissioning engineers usually see a packaging machine only as numbers in the PLC: axis angles, encoder values and
product register entries. RPP Visualisation draws the machine instead. A small TwinCAT library describes which
components are installed and where they are in the machine coordinate system; a gateway on the IPC reads that
description and the live state over ADS, and any browser on the machine network shows the machine in 3D. Nothing
about the machine is entered in the web app, so the view stays correct after every mechanical change.

![From the PLC to the browser](docs/images/overview.svg)

## Features

- **Visualisation** (`/`): conveyors with their product registers, Delta robots, Cartesian robots, XTS gantries and
  loops, vision systems, product sensors and stations, drawn at the poses the PLC reports. Products move as the PLC
  tracks them and are coloured by their state. Includes a component tree, an inspector with the raw PLC values,
  limit violations, metrics, product histories, recording and playback, and a replay buffer of the last minute.
- **Configurator** (`/configurator/`): places a machine's components in 3D, gives them zones, grippers and product
  types, and writes the result to the PLC as parameter sets.
- **Simulator** (`/simulator/`): writes a recipe and sends Start / Stop / Reset to an application in simulation mode.
- **Gateway**: one Node.js service per IPC that discovers the components, reads their state cyclically and streams it
  to the browsers over WebSocket. It only reads, unless writing is explicitly allowed for the configurator and the
  Simulator. It also serves the PLC library guide at `/docs`.
- **Installation**: a self-contained Windows package installed as a service; no internet, Node or .NET needed on the
  IPC.

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/gateway` | Gateway (Node.js, TypeScript): discovery, cyclic reading, WebSocket server, web app hosting |
| `apps/ads-bridge` | .NET bridge the gateway uses to talk ADS to TwinCAT |
| `apps/visualisation` | Visualisation web app (React, Three.js, Vite) |
| `apps/configurator` | Configurator web app |
| `apps/simulator` | Simulator web app |
| `packages/machine-view` | 3D scene and panels shared by the web apps |
| `packages/protocol` | Data model and messages between gateway and browser |
| `plc/` | TwinCAT solution: the libraries `Syn_Visu` and `Syn_Config`, their tests and the demo application |
| `deploy/windows` | Install and uninstall scripts for the Windows service |
| `docs/` | Contracts, guides, ADRs and the project status |

## Getting started

### Requirements

- Node.js 24 and pnpm 12 (through `corepack`)
- .NET 9 SDK, to build the ADS bridge
- TwinCAT 3.1 Build 4026, to run the demo application against a live PLC

### Install, build and test

```powershell
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
```

`pnpm test` runs all unit tests and needs no PLC: the gateway tests use an in-memory PLC.

### Run against the demo PLC

1. Open `plc/RPP_Visu.sln` in TwinCAT XAE, build it, activate the configuration and log in to and start
   `Syn_Visu_Demo` (details in [docs/demo-plc.md](docs/demo-plc.md)).
2. Build the bridge and the web apps, then start the gateway:

   ```powershell
   corepack pnpm build:bridge
   corepack pnpm build
   corepack pnpm dev:gateway
   ```

3. Open <http://localhost:8080>.

For working on a single web app, `pnpm dev:visualisation` (or `dev:configurator`, `dev:simulator`) starts its Vite
dev server, which proxies to the running gateway. `pnpm --filter @rpp/<app> test:e2e` runs an app's browser tests
against the demo application.

## Connecting your own machine

The PLC application references the TwinCAT library `Syn_Visu` and registers one function block instance per
component in a manifest. The [PLC library guide](docs/plc-library-guide.md) explains this step by step; the demo
project `plc/Syn_Visu_Demo` is a complete example. Parameter sets, recipes and machine commands additionally need
the library `Syn_Config` ([docs/config-contract.md](docs/config-contract.md)).

## Installing on an IPC

Every release on GitHub carries a package `rpp-visualisation-X.Y.Z-win-x64.zip` with the gateway, the web apps, the
ADS bridge, a Node runtime and the compiled PLC libraries. Unzip it on the IPC and run `install.ps1` in an elevated
PowerShell; see [docs/deployment.md](docs/deployment.md). How releases are made: [docs/releasing.md](docs/releasing.md).

## Documentation

- [docs/plc-library-guide.md](docs/plc-library-guide.md): connecting a machine, for PLC programmers
- [docs/plc-contract.md](docs/plc-contract.md), [docs/config-contract.md](docs/config-contract.md): the contracts
  between the PLC libraries and the gateway
- [docs/api.md](docs/api.md): the read-only API for your own programs (MES, dashboards, loggers)
- [docs/deployment.md](docs/deployment.md): installing and configuring on an IPC
- [docs/adr/](docs/adr/): architecture decisions
- [GLOSSARY.md](GLOSSARY.md): the domain terms
- [docs/status.md](docs/status.md): current state and open points

## License

[MIT](LICENSE) © 2026 Jan Willner
