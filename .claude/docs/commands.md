# Commands

pnpm monorepo (pnpm 12 through corepack: prefix `corepack` where `pnpm` is not on PATH, as on this PC; the root
scripts that call `pnpm` themselves, e.g. `test:e2e`, then fail: run their parts per app with `--filter`).

| Command | What it does |
| --- | --- |
| `pnpm install` | Install |
| `pnpm test` | All Vitest projects. One file: `pnpm vitest run <path>`; one test: add `-t "<name>"` |
| `pnpm typecheck` | `tsc` in every package (`pnpm -r typecheck`) |
| `pnpm bench` | Benchmarks in `apps/*/bench/`; compare before and after a change (`docs/performance.md`) |
| `pnpm --filter @rpp/<app> test:e2e` | Builds the app and runs its browser tests against the demo PLC |
| `pnpm dev:gateway` | Gateway on :8080 reading the demo on port 852, writing allowed |
| `pnpm dev:visualisation` (`configurator`, `simulator`) | Vite dev server of one app, proxies `/ws` to the gateway |
| `pnpm build` | Builds the three apps' `dist` (shared settings `scripts/web-app-build.mjs`) |
| `pnpm build:bridge` | Builds the .NET ADS bridge (`apps/ads-bridge`, .NET 9 SDK) |
| `pnpm start -- --driver ads --ams-net-id <id>` | Serves the built apps and the WebSocket on one port |
| `pnpm package` | Local Windows package `dist/rpp-visualisation-<version>-win-x64.zip`, for trying out only |

## Browser tests

The gateway runs on :8090 (`E2E_PORT` to change it, e.g. when Windows reserves the port range) and reads the demo
application on the local user-mode runtime (`E2E_AMS_NET_ID`, `E2E_ADS_PORT`; `docs/demo-plc.md`). On Windows they use
the installed Edge, elsewhere `E2E_CHANNEL=chromium` after `pnpm exec playwright install chromium`.

## Gateway options

`node gateway.mjs --help` (or `pnpm start -- --help`) lists them; `--config <file>` reads them from JSON, flags win.
`--allow-write` lets the configurator and the Simulator write; `--driver ads-tcp` needs an ADS route.

## Releases and installing

IPCs get the zip of a GitHub release only, made by the Release workflow on a `v*` tag (`docs/releasing.md`). It
bundles the newest compiled PLC libraries from `plc/library/`. Installing: `docs/deployment.md`, ADR 0004; install
scripts in `deploy/windows/`. Installing on this PC needs an elevated `install.ps1` (a UAC prompt for the user).
