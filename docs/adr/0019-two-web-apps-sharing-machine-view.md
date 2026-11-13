# The visualisation and the configurator are two apps sharing one library, machine-view

This amends ADR 0016, which made the configurator a second page of `apps/web` and kept a separate app for later,
"once the boundary hurts". By the gripper layout (ADR 0018) the configurator had grown to 13 modules and reached into
11 modules of the visualisation by relative paths, among them the inspector's tables (for field names) and the live
store (`GatewayStore`), which carried the visualisation's product history and the configurator's commands at once.
What both pages shared was decided by whatever the configurator happened to import; the build named the shared chunk
after the inspector's table module.

So there are two apps and one library:

- **`packages/machine-view`** (`@rpp/machine-view`) is what both share, and its one entry point (`src/index.ts`) is
  the only module either app imports from it: the gateway connection (`GatewayConnection`: socket, register decoding,
  `Sources`; the messages on parameter sets handed on as they come), the machine scene with its kits and views,
  `SceneView` and the camera views, the rules about the machine (`machine-facts.ts`) and names (`naming.ts`), the
  palette and the shared look (`@rpp/machine-view/styles.css`). It knows neither app. Its `package.json` `exports` keep
  the apps from reaching past the entry point; the gateway's docs page takes only the palette (`@rpp/machine-view/
  palette`).
- **`apps/visualisation`** is served at `/` and builds on the connection its `LiveMachine` (product history and the
  events the metrics count) and everything else that only it shows: the `Viewer`, recordings and playback, the
  inspector, the metrics.
- **`apps/configurator`** is served at `/configurator/` (built with that base path) and builds on the connection its
  `GatewayLive` (parameter sets and the commands on them).
- `SceneView` takes one function giving the scene sources of a moment: the live machine, a recording in playback and a
  draft are its three adapters. It no longer takes the visualisation's feed with product history, nor its list of
  sources.
- Each app has its own stylesheet after the shared one, its own Vite config (shared settings in
  `scripts/web-app-build.mjs`), its tests and its browser tests. The gateway serves the visualisation from
  `--static-dir` and the configurator from `--configurator-dir`; the package puts the configurator into
  `web/configurator/`, where both the gateway and the install script find it without a change.

## Considered Options

- **Keep one app with a named shared folder** (`src/machine-view/` plus an import rule checked by a test). Smaller, but
  the separation would rest on a test rather than on the package graph, and each page would still build, type check
  and test with the other's code in its project.
- **The configurator inside the visualisation's build output** (one `--static-dir`). No new gateway option, but one
  app's build would write into the other's folder.

## Consequences

- The panel PCs load no configurator code and no write commands; the configurator loads no product history or
  recording code. Each app's bundle includes the shared code once; the libraries (three.js, React) are split into the
  same chunks in both.
- A new component type is drawn by both apps through `machine-view` (`docs/adding-a-component.md`); the configurator's
  palette and defaults stay in `apps/configurator`.
- `pnpm dev:visualisation` and `pnpm dev:configurator` start one Vite dev server each; `pnpm build` and `pnpm test:e2e`
  run both.

## Amendment (#44)

The panels the Simulator shares with the visualisation (and partly the configurator) moved into `machine-view` as
well: the component tree, the inspector with the product history and the metrics counted from it, the status bar with
its count and list (`StatusList`, which each app fills: discovery errors, the draft's problems, machine messages) and
the top bar. The visualisation keeps the viewer, recordings and playback; a page that does not show the inspector
loads none of it, as the apps' own chunks show.
