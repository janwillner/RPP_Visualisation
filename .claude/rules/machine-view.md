---
paths:
  - "packages/machine-view/**"
  - "apps/*/src/*App.tsx"
  - "apps/*/src/main.tsx"
---

# Machine view (`packages/machine-view`): what the three apps share

The web is three apps and this library (ADR 0019), React + React Three Fiber. It knows none of the apps. Each app
imports it only through its entry point `@rpp/machine-view` (`src/index.ts`); `package.json` `exports` allow nothing
deeper except `palette` (the gateway's docs page), `styles.css` and `testing` (the apps' tests). No app imports
another. The scene has its own rule (machine-view-scene).

## Seam: `Sources` (`src/sources.ts`)

What the web knows about every source at one moment, live and in playback alike: name, status, config, the machine
its application last reported, the states of the current config version (a new config version or a restarting `tRel`
starts a new timeline; the last second, at least two states), the render time `RENDER_DELAY_MS` behind the newest
state on the source's own `tRel` axis, and `online`. It has no clock: every time is given (`apply(at, message)`,
`sceneSources(t)`). When the browser loses the gateway, `gatewayLost()` gives a `status` per source
(`GATEWAY_LOST`), so recordings and the replay buffer show the outage.

## Connection and live sources

- `GatewayConnection` (`gateway-connection.ts`): the WebSocket all apps read; reconnects, restores states from
  register form (ADR 0013), folds messages into a `Sources` on the `performance.now()` axis, hands parameter messages
  to `onParameterMessage`. An unchanged product stays the same object, which history and encoder rely on: never
  mutate a product.
- `LiveMachine` (`live-machine.ts`): the sources plus every product's history and the product events the metrics
  count; an `InspectorFeed` (the visualisation's live feed, the Simulator's 3D view and inspector).
- **Seam:** `GatewayLive` (`gateway-live.ts`): per source its `parameters` message and the writes on it (`stage`,
  `writes`); the configurator's and the Simulator's live interface. Tests use the real one over `FakeConnection` /
  `FakeGateway` (`testing.ts`). Details in the parameter-sets rule.
- `product-history.ts` follows every product through the messages; `metrics.ts` computes the last 60 s from its
  product events (rates use the time covered before a full minute).

## Panels and page parts (`src/panels/`, `inputs.tsx`, `view-settings.ts`)

- `ComponentTree` (sources, components, faults, limit violations, the machine's run state and messages), `Inspector`
  (state values and tables from `state-rows.ts`, a product's history, the metrics; reads an `InspectorFeed`),
  `StatusBar` (gateway, PLC, data age, discovery errors, guide link, version; takes an app's own lists as children),
  `StatusList` (a count that opens its list; an entry may select its component), `TopBar`, `useTick`.
- `NumberInput` / `TextInput` commit on Enter or blur as one step; Escape restores (look `.property`).
- `useMachineView(storageKey, defaultLayers)`: layers, hidden components and sources, camera, remembered per device;
  `parseViewSettings` falls back to the defaults entry by entry. `useLeaveGuard(ask)` asks before leaving a page
  with something unsaved. `useSidePanel` / `SidePanelControls`: side panels opened by a tab, resized by dragging,
  remembered per device.
- `naming.ts`: `fieldLabel`, `singular`, `componentName`. `ViewControls`: camera views framing the parts where they
  are now. The shared look is `styles.css`; each app adds its own stylesheet after it.
