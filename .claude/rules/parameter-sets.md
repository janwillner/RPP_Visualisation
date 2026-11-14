---
paths:
  - "apps/gateway/src/parameter-access.ts"
  - "apps/gateway/src/recipe-access.ts"
  - "apps/gateway/src/staging.ts"
  - "apps/gateway/src/config-*.ts"
  - "apps/gateway/src/plc-writing.ts"
  - "apps/gateway/test/parameters.test.ts"
  - "apps/gateway/test/recipes.test.ts"
  - "packages/protocol/src/parameters.ts"
  - "packages/protocol/src/recipe-file.ts"
  - "packages/machine-view/src/gateway-live.ts"
  - "apps/configurator/src/writing.ts"
  - "apps/simulator/**"
  - "plc/Syn_Config/**"
---

# Parameter sets, recipes and machine commands (Syn_Config)

Writing to a PLC goes only through the library `Syn_Config` (ADR 0017, 0022); contract and usage:
`docs/config-contract.md`. The application lists its FBs in `GVL_Config.stManifest`.

## Parameter sets (ADR 0017)

One parameter FB per component (`vision` / `sensor` / `station` share one structure). A set holds a type's
`parameters` (`COMPONENT_SCHEMAS`): pose, origin shift, zones, product types, track modules, fingers, areas; never
hardware. `parameter-access.ts` finds the FBs at discovery and reads `stStatus` and `stActive` every cycle into a
`parameters` message per source (only for a PLC with Syn_Config; `writable` only with `--allow-write`). Leaf paths
come from the schema by the naming convention (`plc-writing.ts`).

## Recipes and machine commands (ADR 0022)

The application's one machine FB `_FB_ConfigMachine` (manifest id 0, type NONE) declares the recipe fields: name,
group (component id or 0), type number / integer / switch / choice, unit, min, max, program value, choices; from
config protocol 4 also label, description and a visibility condition (`m_SetVisibleWhen`). Values travel by index as
LREAL. `recipe-access.ts` reads the declarations at discovery; a condition that cannot hold (on a number field, on
itself, on a field not declared, on a value it can never have, in a ring) is a discovery error and dropped. Machine
commands (start / stop / reset) are acknowledged requests the application answers.

## Writing

- The order that makes a write safe is in `staging.ts`: a waiting set withdrawn first, values, base version, stage id,
  `bStaged` (or `bReset`) last, all in one sum-write. Machine commands: `bRequested` last.
- `writeBlockedReason(kind, facts)` (`parameters.ts`) is the one rule whether a source takes a write: PLC connected,
  Syn_Config, `--allow-write`, and for recipes and commands a machine FB and simulation mode. The gateway refuses by
  it, the configurator and the Simulator block by it. `writeKindOf` maps a command to its kind.
- The gateway also refuses a foreign origin, a stale base version, an unknown field and a value of the wrong type or
  range (`invalidRecipeValue`, shared with the Simulator).
- **Seam:** machine-view's `GatewayLive.stage(command)` sends a write and follows it in `writes` (by `writeKey`) until
  the PLC handled it: staged, waiting, applied, rejected; failed when refused, unanswered for 10 s or the connection
  was lost. Both apps read writes only from there.

## Emulation

`config-emulation.ts` emulates Syn_Config and an application passing its effective values on to Syn_Visu, generically
by the naming convention, including the machine FB (`recipeField`, `answerCommand`) and config protocols 2 to 4.

## Versions

Config protocol 2: fingers (Syn_Config 2.0); 3: machine FB (2.1); 4: field texts and conditions (2.2). The gateway
still writes parameter sets to protocol 2 (`MIN_CONFIG_PROTOCOL_VERSION`). An active recipe saved before a field was
appended gives that field 0, not its program value.
