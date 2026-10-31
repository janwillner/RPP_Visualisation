# Deploying to a Beckhoff IPC

The decision and its reasons are in [ADR 0004](adr/0004-deploy-as-self-contained-windows-service.md). The package is built with `pnpm package` (output: `dist/rpp-visualisation-<version>-win-x64.zip`). On every `v*` tag, the Release workflow builds it and attaches it to the GitHub release.

This guide is for commissioning and service technicians. It covers installing the visualisation on an IPC, configuring it, updating it and troubleshooting it.

## Requirements

- Windows 10/11 x64, build 1607 or newer (LTSC 2019/2021 included), with TwinCAT 3.
- The PLC project uses the `Syn_Visu` library (`plc/library/Syn_Visu_<version>.library` in the repo, installed under the title `SynVisu`). Its version must match the protocol version of the gateway release; the release notes name the matching version.
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
  "configRecheckMs": 1000,
  "manifestPath": "GVL_Visu.stManifest"
}
```

| Key | Meaning |
| --- | --- |
| `driver` | `ads` on an IPC. `sim` runs the built-in simulator without a PLC. |
| `amsNetId` | ADS target. `127.0.0.1.1.1` is the runtime on this IPC; another IPC needs an ADS route (see below). |
| `adsPort` | PLC runtime port: 851 for the first runtime, 852 for the second, and so on. |
| `port` | HTTP and WebSocket port of the page. |
| `cycleMs` | Acquisition cycle in milliseconds. |
| `configRecheckMs` | How often the full configuration is re-read to catch live changes (0 = off). |
| `manifestPath` | Symbol path of the manifest in the PLC. Change it only if the PLC application declares the manifest in a GVL with another name. |

The file may also contain any other gateway option in camelCase; `node.exe gateway.mjs --help` lists them all. Unknown keys and wrong types stop the service with a message in the log.

Restart the service after editing the file: `Restart-Service RPP_Visualisation`. If you change `port`, run `install.ps1` again so the firewall rule follows.

**Several PLC runtimes on one IPC:** each runtime gets its own service with its own config file, ADS port and HTTP port:

```powershell
.\install.ps1 -Instance 852 -AdsPort 852 -Port 8081
```

This creates the service `RPP_Visualisation_852` with `C:\ProgramData\RPP_Visualisation\config-852.json`. A new instance needs `-Port`, and `-AdsPort` or `-AmsNetId`, so it cannot collide with the default instance. All instances share the program files, so running `install.ps1` without parameters later updates every instance. `Get-Help .\install.ps1 -Detailed` lists all parameters.

## Reading other IPCs over an ADS route

One visualisation can read the PLCs of several IPCs, for example when a machine's modules run on separate IPCs. It shows all of them in one 3D view. Install it on one IPC (or the HMI PC) with TwinCAT; it reads the other IPCs through TwinCAT's own ADS router.

1. **Create an ADS route** from the IPC running the visualisation to every other IPC, as usual in TwinCAT: in XAE choose *Choose Target System → Search (Ethernet) → Add Route*, or use *Router → Edit Routes* in the TwinCAT tray menu. You need the target's user name and password once; the visualisation stores none.
2. **Open the ADS port in the firewall** between the IPCs: TCP 48898 (and UDP 48899 for the route search).
3. **List the PLCs** under `sources` in `config.json` instead of `amsNetId` / `adsPort`:

   ```json
   {
     "driver": "ads",
     "port": 8080,
     "sources": [
       { "name": "Infeed PLC", "amsNetId": "127.0.0.1.1.1", "adsPort": 851 },
       { "name": "Outfeed PLC", "amsNetId": "5.12.34.56.1.1", "adsPort": 851 }
     ]
   }
   ```

   `name` is optional (default `<AmsNetId>:<port>`) and `adsPort` defaults to 851. A second runtime on the same IPC is its own entry with the same AmsNetId. Restart the service afterwards. Running `install.ps1` again for an update does not change the list.

All PLCs must report positions in the same MCS of the machine. Component ids need to be unique only within one PLC. Every PLC is read on its own: if one IPC is not reachable, the others stay live, its components stay visible but faded, and the status bar shows "PLC: 1/2 online" with the reason in its list. In the embedded HMI page a red note in the 3D view names the PLC instead. A product that passes from one PLC's component to another's is shown as two products, one per PLC.

For one remote PLC only, the installer can write the config: `.\install.ps1 -AmsNetId 5.12.34.56.1.1`.

## Embedding in TwinCAT HMI

Service technicians can open the visualisation on the machine's touch panel (13 to 19 inch) as a page of the machine HMI. Mouse and touch both work; on a touch panel the controls are finger-sized.

1. In the TwinCAT HMI project, add a **Web Browser** control (or another iframe based control) to a content page.
2. Set its source to `http://<IPC host name or IP>:<port>/?embedded`, for example `http://192.168.1.10:8080/?embedded`.
   - Use the IPC's name or address, not `localhost`: the panel may be a separate client of the HMI server.
   - `<port>` is the instance's `port` (8080 by default, one port per instance).
   - `?embedded` hides the title and the status bar, because the HMI page has its own header. Leave it out to get the full page, e.g. in a separate browser.
3. Make the control fill the page. Below 1600 px width the side panels start collapsed; the "Components" and "Inspector" buttons open them, and the panel remembers the choice.

**Requirement: the HMI runs over http.** The visualisation is served over http only. A browser blocks an http frame inside an https page (mixed content), so embedding works only when the HMI itself is opened over http (for example port 1010, not the https port 1020). The installer's firewall rule already opens the instance port.

Over http the browser offers no clipboard, so the measure list's copy buttons are hidden there.

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
| A remote PLC reports "Target machine could not be found" | The ADS route from this IPC to the target is missing or uses another AmsNetId; check *Router → Edit Routes*. Firewall: TCP 48898. |
| Protocol version mismatch is shown | The gateway release and the `Syn_Visu` version in the PLC project do not match. Install the matching release. |
| The service will not start, or the ADS bridge is blocked | Look at the logs. Check whether SmartScreen or the virus scanner blocked `AdsBridge.exe`; if so, add `C:\Program Files\RPP_Visualisation\` as an exception. |

Logs are written to `C:\ProgramData\RPP_Visualisation\logs\` and rotated automatically: `<service>.out.log` holds the gateway output, `<service>.err.log` holds errors, and `<service>.wrapper.log` holds service starts, stops and restarts.
