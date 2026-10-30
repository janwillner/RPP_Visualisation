# Deploying to a Beckhoff IPC

The decision and its reasons are in [ADR 0004](adr/0004-deploy-as-self-contained-windows-service.md). The package is built with `pnpm package` (output: `dist/rpp-visualisation-<version>-win-x64.zip`). On every `v*` tag, the Release workflow builds it and attaches it to the GitHub release.

This guide is for commissioning and service technicians. It covers installing the visualisation on an IPC, configuring it, updating it and troubleshooting it.

## Requirements

- Windows 10/11 x64, build 1607 or newer (LTSC 2019/2021 included), with TwinCAT 3.
- The PLC project uses the `Syn_Visu` library. Its version must match the protocol version of the gateway release; the release notes name the matching version.
- Administrator rights for installation. The IPC needs no internet access, and no Node or .NET installation.

## Install

1. Copy `rpp-visualisation-X.Y.Z-win-x64.zip` to the IPC and unzip it to any folder.
2. Run this in an elevated PowerShell in that folder:

   ```powershell
   .\install.ps1
   ```

   The script:
   - stops every installed `RPP_Visualisation` service
   - copies the program files to `C:\Program Files\RPP_Visualisation\`, replacing the old ones
   - creates `C:\ProgramData\RPP_Visualisation\config.json` with default values if it does not exist yet; an existing file is left unchanged
   - registers every instance again and starts it (automatic start, restart after a crash, priority `BelowNormal`). If one instance fails, the others still start and the script names the failure at the end.
   - adds a firewall rule for the HTTP port
3. Open `http://<ipc-address>:8080` in a browser on another computer on the machine network.

The service can start before TwinCAT is running. It connects as soon as the PLC answers.

## Configure

The configuration lives in `C:\ProgramData\RPP_Visualisation\config.json`:

```json
{
  "driver": "ads",
  "amsNetId": "127.0.0.1.1.1",
  "adsPort": 851,
  "port": 8080,
  "cycleMs": 20,
  "configRecheckMs": 1000
}
```

| Key | Meaning |
| --- | --- |
| `driver` | `ads` on an IPC. `sim` runs the built-in simulator without a PLC. |
| `amsNetId` | ADS target. Keep `127.0.0.1.1.1` (the local runtime). |
| `adsPort` | PLC runtime port: 851 for the first runtime, 852 for the second, and so on. |
| `port` | HTTP and WebSocket port of the page. |
| `cycleMs` | Acquisition cycle in milliseconds. |
| `configRecheckMs` | How often the full configuration is re-read to catch live changes (0 = off). |

The file may also contain any other gateway option in camelCase; `node.exe gateway.mjs --help` lists them all. Unknown keys and wrong types stop the service with a message in the log.

Restart the service after editing the file: `Restart-Service RPP_Visualisation`. If you change `port`, run `install.ps1` again so the firewall rule follows.

**Several PLC runtimes on one IPC:** each runtime gets its own service with its own config file, ADS port and HTTP port:

```powershell
.\install.ps1 -Instance 852 -AdsPort 852 -Port 8081
```

This creates the service `RPP_Visualisation_852` with `C:\ProgramData\RPP_Visualisation\config-852.json`. A new instance needs both `-AdsPort` and `-Port`, so it cannot collide with the default instance. All instances share the program files, so running `install.ps1` without parameters later updates every instance. `Get-Help .\install.ps1 -Detailed` lists all parameters.

## Update and roll back

To update, run `install.ps1` from the newer zip. To roll back, run it from the older zip. `config.json` and the logs are kept either way.

## Uninstall

```powershell
& "C:\Program Files\RPP_Visualisation\uninstall.ps1"
```

This removes all services, the program files and the firewall rules. `C:\ProgramData\RPP_Visualisation\` is kept unless you pass `-RemoveData`. To remove only one additional instance, pass `-Instance 852`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| The page does not load | `Get-Service RPP_Visualisation` shows `Running`. The firewall rule exists. The port in `config.json` is the one you opened. |
| The page loads but says the PLC is not connected | TwinCAT is in Run mode and the PLC is running. `adsPort` matches the runtime. |
| Protocol version mismatch is shown | The gateway release and the `Syn_Visu` version in the PLC project do not match. Install the matching release. |
| The service will not start, or the ADS bridge is blocked | Look at the logs. Check whether SmartScreen or the virus scanner blocked `AdsBridge.exe`; if so, add `C:\Program Files\RPP_Visualisation\` as an exception. |

Logs are written to `C:\ProgramData\RPP_Visualisation\logs\` and rotated automatically: `<service>.out.log` holds the gateway output, `<service>.err.log` holds errors, and `<service>.wrapper.log` holds service starts, stops and restarts.
