---
paths:
  - "plc/**"
  - "docs/plc-contract.md"
  - "docs/plc-library-guide.md"
  - "docs/config-contract.md"
  - "docs/plc-coding-guidelines.md"
  - "docs/demo-plc.md"
---

# PLC projects (`plc/RPP_Visu.sln`, TwinCAT 3.1.4026)

Read and change PLC code only through the TwinCAT MCP tools; never open `.TcPOU`, `.TcDUT`, `.TcGVL`, `.plcproj`,
`.tsproj` or `.xtv` with file tools, git diffs or scripts. PLC code follows `docs/plc-coding-guidelines.md` (company
guideline); `Syn_Visu`'s contract names stay Beckhoff-style.

## Projects

- `Syn_Visu`: the library the visualisation reads (contract `docs/plc-contract.md`; guide for PLC programmers with
  method reference and diagrams `docs/plc-library-guide.md`, served at `/docs`). Keep library, `plc-contract.ts` and
  both docs in step; a contract change bumps `PROTOCOL_VERSION` and `VISU_un_PROTOCOL_VERSION` together.
- `Syn_Config`: parameter sets, recipes and machine commands (`docs/config-contract.md`); see the parameter-sets rule.
- `Syn_Visu_Demo`: the demo application on ADS port 852 (`docs/demo-plc.md`); the dev gateway and every browser test
  read it, `P_VisuDemoStress` serves load tests.
- `Syn_Visu_Test`: TcUnit suites `_FB_Test*` (Syn_Visu) and `_FB_TestConfig*` (Syn_Config) on port 853, run by
  `P_TestRun`, against the *installed* libraries: install a new version before testing it.
- Releases: `plc/library/<Name>_<version>.library` and `.compiled-library` (the package ships the newest compiled);
  a library version bump touches the version function, the version constant, the project info and the version
  history in the changed POUs' headers.

## Working with the MCP tools

- The solution may be closed. If no XAE runs (no projects found, or RPC 0x800706BA), start
  `C:\Program Files\Beckhoff\TcXaeShell\Common7\IDE\TcXaeShell.exe "plc\RPP_Visu.sln"`, wait until the window title
  shows `RPP_Visu`, then attach.
- A call without an answer after 5 minutes: retry once after re-attaching; if it hangs again, take another tool or
  smaller steps, or ask the user to close a modal dialog in XAE.
- Check a project after every change (`plc_check_all_objects`), then build the solution. Error-list lines from TcUnit
  (`'TestTask' ... Tests: 70`) are old test logs, not build errors.
- The target is the user-mode runtime `UmRT_Default` (169.254.123.103.1.1, this PC); online calls need
  `allowLocalSystem`. ADS reads go to `local` with the project's port (852 demo, 853 tests).
- After activating the configuration, a project's symbols appear over ADS only once it was logged in with a download
  and started; then log out and generate its boot project so a restart keeps the new code.
- TcUnit results: `GVL_TcUnit.TcUnitRunner.TestResults.TestSuiteResults` (`NumberOfTestCases`,
  `NumberOfFailedTestCases`) on port 853.
- The demo's active recipe and parameter sets are persistent: return them to their program values after a test.
