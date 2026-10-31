# Deploy as a self-contained Windows service on each IPC

The visualisation runs on every Beckhoff IPC, next to the PLC it shows. It is shipped as a self-contained zip (`rpp-visualisation-X.Y.Z-win-x64.zip`) and installed as a Windows service. The zip holds a pinned LTS `node.exe`, the gateway bundled into one file with esbuild, the built web app, the ADS bridge published as a self-contained single-file `AdsBridge.exe`, the WinSW service wrapper, and `install.ps1` / `uninstall.ps1`. The IPC needs no Node, pnpm, .NET runtime or internet access. Running locally keeps the bridge on the local AMS router (ADR 0001), so no ADS route has to be configured.

This amends one consequence of ADR 0001. That ADR accepted a .NET 9 runtime on the IPC. The bridge now ships self-contained, so the IPC needs no .NET installation.

## Decisions

- **Target:** Windows 10/11 x64, build 1607 or newer (LTSC 2019/2021 included). Windows 7, Windows Embedded Standard 7, Windows CE and TwinCAT/BSD are not supported.
- **One service per PLC runtime:** each service has its own ADS port and HTTP port. The default is ADS port 851 served on HTTP port 8080. A single gateway serving several runtimes would need code changes and is not planned. (Amended by ADR 0005: one gateway may now read several PLC sources, including other IPCs over ADS routes; one service per machine remains the default.)
- **Service:** WinSW runs the service. It starts automatically at boot, restarts after a crash and runs at `BelowNormal` priority. The service may start before TwinCAT: the gateway treats every failed read as a lost connection and runs discovery again once the PLC answers. WinSW v2 applies service settings only when a service is registered, so `install.ps1` registers every instance again on each update.
- **Layout:** program files go to `C:\Program Files\RPP_Visualisation\`, and an update replaces this folder completely. Machine-specific settings (`config.json`, read through `--config`) and rotating logs go to `C:\ProgramData\RPP_Visualisation\` and survive updates.
- **Access:** the page is read-only and needs no login or TLS. Anyone on the machine network can open it. `install.ps1` adds a firewall rule for the HTTP port. Viewers use a remote browser; the IPC does not render the scene itself.
- **Delivery:** the package is part of the machine image at commissioning. It is installed with `install.ps1`, separately from the TwinCAT project. An update or rollback means installing another zip.
- **Compatibility:** each gateway release supports exactly one protocol version. A mismatch shows up in the UI, and the release notes name the matching `Syn_Visu` version.
- **Build:** `pnpm package` is the only way the zip is produced. On every tag `vX.Y.Z`, GitHub Actions runs it on a Windows runner and attaches the zip to the release.
- **Signing:** the zip is not code-signed for now. If SmartScreen or a customer's virus scanner blocks it, the install folder is added as an exception.

## Considered Options

- **A central server that reads many IPCs over ADS routes.** Rejected: it needs a route per IPC, and the visualisation would depend on the plant network.
- **Installing Node, pnpm and the .NET runtime on each IPC and running from source.** Rejected: IPCs are usually offline, and a runtime installed separately on each machine fails in ways that are hard to support in the field.
- **A Node single executable application (SEA).** Rejected for now: the feature is still young, and it is harder to diagnose on site than a plain `node.exe` with a readable bundle.
- **Deploying through TwinCAT "Deployment" entries on configuration activation.** Rejected: activating a configuration should not reinstall services, and visualisation updates must not require activating the configuration again.
- **TwinCAT/BSD.** Not supported: .NET 9 is not officially available there, so it would need a separate path, e.g. `--driver ads-tcp`.
- **Supporting several protocol versions in one gateway.** Deferred until machines in the field can no longer be updated together with the PLC library.

## Consequences

- The gateway must start the bridge as an executable instead of `dotnet <dll>`, read a `--config` file, and resolve its default paths relative to the package instead of the repo layout.
- Older or non-Windows IPCs cannot run the visualisation locally.
