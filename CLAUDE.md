# CLAUDE.md

Guidance for Claude Code in this repository: a read-only web visualisation of packaging machines that configures
itself from what the PLC reports (spec: GitHub issue #1), with a configurator and a Simulator beside it.

## Working style

Caution over speed; on trivial tasks use judgement.

**Think before coding.** State your assumptions. When a request has several readings, name them instead of picking
one silently. Say when a simpler approach exists and push back when warranted. When something is unclear, stop, name
what is unclear and ask.

**Simplicity first.** The minimum code that solves the problem: only what was asked, no abstraction for single-use
code, no configurability nobody requested, no error handling for impossible cases. If 200 lines could be 50, rewrite
them. The test: would a senior engineer call it overcomplicated?

**Surgical changes.** Every changed line traces to the request. Match the existing style, leave adjacent code,
comments and formatting as they are, and mention unrelated dead code instead of deleting it. Remove the imports,
variables and functions your own change left unused, and only those.

**Goal-driven.** Turn a task into a checkable goal and loop until it is met: "add validation" → tests for invalid
input, then make them pass; "fix the bug" → a test that reproduces it, then make it pass; "refactor" → tests green
before and after. For several steps, state a short plan with a check per step.

## Project rules

- **English** for everything in the repo: code, identifiers, comments, docs, ADRs, glossary, issues, PRs and commit
  messages, also when the conversation is in German.
- **PLC code** (`plc/`) is read and changed only through the TwinCAT MCP tools, never with file tools or scripts.
- **Tests live at the seams.** Each area's rules name its seams; test through them, not past them.
- **One truth per contract.** The PLC libraries, their TypeScript side and their contract docs change together
  (`docs/plc-contract.md`, `docs/config-contract.md`); a contract change bumps the protocol version on both sides.
- **Agent docs** live in `.claude/`: each fact in one place, every file under 100 lines of at most 120 characters.

## Where to look

The area rules in `.claude/rules/` load by themselves when you work on their paths: protocol, gateway, parameter sets
and recipes, machine-view (scene; panels and live sources), visualisation, configurator, Simulator, PLC, tests.

Read when the task needs it:

- `.claude/docs/commands.md`: install, test, typecheck, benchmarks, browser tests, dev servers, build, package.
- `.claude/docs/adding-a-component.md`: a new component type, from the PLC to the 3D view and the configurator.
- `docs/demo-plc.md`: the demo application the dev gateway and the browser tests read, and what a test may change.
- `docs/releasing.md`, `docs/deployment.md`: making a release, installing on an IPC.
- `docs/adr/`: why things are as they are. `GLOSSARY.md`: the domain words to use in code and docs.
- `docs/status.md`: the current state and the open points.

## Agent skills

- Issue tracker: GitHub Issues on janwillner/RPP_Visualisation via `gh` (`docs/agents/issue-tracker.md`).
- Triage labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix (`docs/agents/triage-labels.md`).
- Domain docs: single context, one `GLOSSARY.md` and `docs/adr/` at the root (`docs/agents/domain.md`).
