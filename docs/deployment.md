# Installing on a Beckhoff IPC

For commissioning and service technicians. Use only the zip from a GitHub release (`rpp-visualisation-X.Y.Z-win-x64.zip`).

## Requirements

- [ ] Windows 10/11 x64, build 1607 or newer (LTSC 2019/2021 included), with TwinCAT 3
- [ ] Administrator rights (no internet, Node or .NET needed)
- [ ] PLC project references the `Syn_Visu` library of the version in the package: on the engineering PC install `plc\Syn_Visu_<version>.compiled-library` (XAE: PLC → Library Repository → Install), reference it and download the PLC project
- [ ] Only where the configurator writes parameter sets: the PLC project also references `plc\Syn_Config_<version>.compiled-library` (`docs/config-contract.md`), and the gateway runs with `--allow-write` (or `"allowWrite": true` in its config file)
- [ ] Remote PLCs only: ADS route and firewall, see [Several IPCs](#several-ipcs)

## Install or update

1. Unzip the release zip on the IPC.
2. In that folder, in an elevated PowerShell:

   ```powershell
   .\install.ps1
   ```

3. The script ends green. Red: read the instance name and error shown, fix (usually `config.json` or the port) and run it again. Yellow "PLC not connected": fine, the service connects once the PLC runs.
4. Open `http://<ipc-address>:8080` from another PC on the machine network.

Updating and rolling back are the same: run `install.ps1` from the zip of the wanted release. `config.json` and logs are kept. Installed version: status bar of the page, `/health` (`version`) or `C:\Program Files\RPP_Visualisation\VERSION`.

## Configure

File: `C:\ProgramData\RPP_Visualisation\config.json` (created by the first install, never overwritten).

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

| Key | Set to |
| --- | --- |
| `driver` | `ads` (the default); `ads-tcp` for the pure TCP client, which needs an ADS route |
| `amsNetId` | `127.0.0.1.1.1` for this IPC, otherwise the AmsNetId of the remote IPC |
| `adsPort` | PLC runtime: 851, 852, ... |
| `port` | HTTP port of the page |
| `cycleMs` | Acquisition cycle in ms |
| `configRecheckMs` | Re-read of the configuration in ms, 0 = off |
| `manifestPath` | Only change if the PLC declares the manifest in another GVL |

More options: `node.exe gateway.mjs --help` in `C:\Program Files\RPP_Visualisation\` (keys in camelCase). Unknown keys or wrong types stop the service.

After editing: `Restart-Service RPP_Visualisation`. After changing `port`: run `install.ps1` again (firewall rule).

### Several runtimes on one IPC

One service per runtime, each with its own ADS port and HTTP port:

```powershell
.\install.ps1 -Instance 852 -AdsPort 852 -Port 8081
```

Creates the service `RPP_Visualisation_852` with `config-852.json`. A new instance needs `-Port` and `-AdsPort` or `-AmsNetId`. A later `.\install.ps1` without parameters updates all instances. All parameters: `Get-Help .\install.ps1 -Detailed`.

### Several IPCs

One visualisation can show the PLCs of several IPCs in one view.

1. Create an ADS route from this IPC to every other IPC (XAE: *Choose Target System → Search (Ethernet) → Add Route*, or tray: *Router → Edit Routes*).
2. Open TCP 48898 (and UDP 48899 for the route search) between the IPCs.
3. Replace `amsNetId` / `adsPort` in `config.json` with `sources`:

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

   `name` is optional, `adsPort` defaults to 851. A second runtime on the same IPC is its own entry.
4. `Restart-Service RPP_Visualisation`.

All PLCs must report positions in the same machine coordinate system (MCS). For a single remote PLC, `.\install.ps1 -AmsNetId 5.12.34.56.1.1` writes the config on first install.

### TwinCAT HMI

1. Add a **Web Browser** control to an HMI content page and make it fill the page.
2. Source: `http://<IPC name or IP>:<port>/?embedded`, e.g. `http://192.168.1.10:8080/?embedded` (not `localhost`).
3. Open the HMI over **http** (e.g. port 1010), not https: browsers block an http frame inside an https page.

Downloads (saving recordings) may be blocked in the HMI control; use a normal browser then.

## Uninstall

```powershell
& "C:\Program Files\RPP_Visualisation\uninstall.ps1"
```

Removes services, program files and firewall rules. Add `-RemoveData` to delete `C:\ProgramData\RPP_Visualisation\` too, or `-Instance 852` to remove only that instance.

## Monitoring

`http://<ipc>:<port>/health`: HTTP 200 when every PLC is connected, 503 otherwise; the JSON body names the failing source and its `lastError`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Page does not load | `Get-Service RPP_Visualisation` is `Running`; firewall rule exists; `port` matches |
| PLC not connected | TwinCAT in Run mode, PLC running, `adsPort` correct |
| Remote PLC: "Target machine could not be found" | ADS route missing or wrong AmsNetId (*Router → Edit Routes*); TCP 48898 open |
| Protocol version mismatch | `Syn_Visu` version in the PLC does not match the release; install the matching pair |
| Service does not start / ADS bridge blocked | Read the logs; add `C:\Program Files\RPP_Visualisation\` as exception in SmartScreen or the virus scanner |

Logs in `C:\ProgramData\RPP_Visualisation\logs\`: `<service>.err.log` (errors), `<service>.out.log` (output), `<service>.wrapper.log` (starts, stops, restarts).
