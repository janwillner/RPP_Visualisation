<#
.SYNOPSIS
    Installs or updates the RPP visualisation as a Windows service.

.DESCRIPTION
    Run from the unzipped package in an elevated PowerShell.

    - Copies this package next to C:\Program Files\RPP_Visualisation\ first, while the services still run.
    - Stops every installed RPP_Visualisation service and swaps in the new program files. If the swap fails, the
      old program files stay in place and the services are started again.
    - Creates C:\ProgramData\RPP_Visualisation\config.json (or config-<Instance>.json) if it is missing.
      An existing config file is never changed.
    - Registers the service (automatic start, restart after a crash, priority BelowNormal). Every other installed
      instance is registered again too, so service settings from the new package take effect everywhere.
    - Adds a firewall rule for each instance's HTTP port.
    - Starts all instances and checks that each one answers on /health (up to 20 s per instance). If one fails, the others are
      still started and the script reports the failure with the end of its error log. A PLC that is not
      connected yet is only a warning: the service connects when the PLC answers.

    Running it from an older package rolls back. Logs: C:\ProgramData\RPP_Visualisation\logs\.

.PARAMETER Instance
    Name of an additional instance for another PLC, e.g. "852" or "line2".
    The service is then RPP_Visualisation_<Instance> with config-<Instance>.json.
    Leave empty for the default instance. "default" is reserved.

.PARAMETER AmsNetId
    AmsNetId of the PLC, written only into a newly created config file. Default: 127.0.0.1.1.1 (this IPC).
    Another IPC needs an ADS route from this IPC to it (docs/deployment.md, "Reading other IPCs over an ADS route").
    Several PLCs in one view: list them under "sources" in the config file instead.

.PARAMETER AdsPort
    ADS port of the PLC runtime, written only into a newly created config file. Default: 851.
    A new additional instance needs -AdsPort or -AmsNetId, so that it reads another PLC than the default instance.

.PARAMETER Port
    HTTP port of the page, written only into a newly created config file. Default: 8080.
    Required for a new additional instance, so it does not collide with the default instance.

.EXAMPLE
    .\install.ps1

.EXAMPLE
    .\install.ps1 -Instance 852 -AdsPort 852 -Port 8081

.EXAMPLE
    .\install.ps1 -Instance line2 -AmsNetId 5.12.34.56.1.1 -Port 8082
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9-]*$')]
    [string]$Instance = '',
    [ValidatePattern('^\d{1,3}(\.\d{1,3}){5}$')]
    [string]$AmsNetId = '127.0.0.1.1.1',
    [ValidateRange(1, 65535)]
    [int]$AdsPort = 851,
    [ValidateRange(1, 65535)]
    [int]$Port = 8080
)

$ErrorActionPreference = 'Stop'
$Product = 'RPP_Visualisation'
$InstallDir = Join-Path $env:ProgramFiles $Product
$DataDir = Join-Path $env:ProgramData $Product
$ServiceDir = Join-Path $DataDir 'service'
$LogDir = Join-Path $DataDir 'logs'
$Source = $PSScriptRoot
$StagingDir = "$InstallDir.new"
$PreviousDir = "$InstallDir.old"
$HealthTimeout = [TimeSpan]::FromSeconds(20)

function Get-ServiceId([string]$Name) { if ($Name) { "${Product}_$Name" } else { $Product } }
function Get-InstanceName([string]$ServiceId) { $ServiceId.Substring($Product.Length).TrimStart('_') }
function Get-ConfigPath([string]$Name) {
    if ($Name) { Join-Path $DataDir "config-$Name.json" } else { Join-Path $DataDir 'config.json' }
}
function Get-InstalledServiceIds {
    @(Get-Service -Name "$Product*" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "^$Product(_[A-Za-z0-9-]+)?$" } |
        ForEach-Object { $_.Name })
}
function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false))
}
function Get-HttpPort([string]$ConfigPath) {
    $config = Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json
    if ($config.port) { [int]$config.port } else { 8080 }
}
# The processes of the visualisation: service wrappers, gateway (node) and ADS bridge.
function Get-VisualisationProcesses {
    @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -and ($_.Path.StartsWith("$InstallDir\", 'OrdinalIgnoreCase') -or
                $_.Path.StartsWith("$ServiceDir\", 'OrdinalIgnoreCase'))
        })
}
function Stop-Instances([string[]]$Ids) {
    foreach ($id in $Ids) {
        Write-Host "  stopping $id"
        Stop-Service -Name $id -Force
        (Get-Service -Name $id).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    # A stopped service's processes may still be ending, and a wrapper between two restarts of a crashing gateway
    # stays alive although the service shows Stopped. Their files must be free before they are replaced.
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-VisualisationProcesses).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    Get-VisualisationProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
}
# GET /health of an instance: its status code (200, or 503 while a PLC is not connected) and body; $null if the
# gateway does not answer.
function Get-Health([int]$HttpPort) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://localhost:$HttpPort/health"
        return @{ Status = [int]$response.StatusCode; Body = $response.Content }
    } catch [System.Net.WebException] {
        $response = $_.Exception.Response
        if (-not $response) { return $null }
        $body = (New-Object System.IO.StreamReader($response.GetResponseStream())).ReadToEnd()
        return @{ Status = [int]$response.StatusCode; Body = $body }
    }
}
# The last lines of an instance's error log, indented for the failure report.
function Get-ErrorLogTail([string]$Id) {
    $log = Join-Path $LogDir "$Id.err.log"
    if (-not (Test-Path $log)) { return '      (no error log)' }
    # A crashing gateway is restarted and writes the same lines again.
    $tail = @(Get-Content -Path $log -Tail 8 | Where-Object { $_.Trim() } | Select-Object -Unique)
    if ($tail.Count -eq 0) { return '      (error log is empty)' }
    ($tail | ForEach-Object { "      $_" }) -join "`n"
}

foreach ($file in 'node.exe', 'gateway.mjs', 'AdsBridge.exe', 'winsw.exe', 'web') {
    if (-not (Test-Path (Join-Path $Source $file))) { throw "Package incomplete: $file is missing next to install.ps1." }
}
if ($Instance -eq 'default') { throw '"default" is reserved for the default instance; leave -Instance empty.' }
if ($Instance -and -not (Test-Path (Get-ConfigPath $Instance)) -and
    -not ($PSBoundParameters.ContainsKey('Port') -and
        ($PSBoundParameters.ContainsKey('AdsPort') -or $PSBoundParameters.ContainsKey('AmsNetId')))) {
    throw "A new instance needs its own PLC and HTTP port: pass -AdsPort or -AmsNetId, and -Port, e.g. -Instance $Instance -AdsPort 852 -Port 8081."
}
$version = (Get-Content -Raw (Join-Path $Source 'VERSION')).Trim()
$targetId = Get-ServiceId $Instance
$serviceIds = @(Get-InstalledServiceIds)
if ($serviceIds -notcontains $targetId) { $serviceIds += $targetId }

$installedVersionFile = Join-Path $InstallDir 'VERSION'
$installedVersion = if (Test-Path $installedVersionFile) { (Get-Content -Raw $installedVersionFile).Trim() }
if (-not $installedVersion) {
    Write-Host "Installing RPP visualisation $version"
} elseif ($installedVersion -eq $version) {
    Write-Host "Installing RPP visualisation $version again (same version)"
} else {
    Write-Host "Installing RPP visualisation $version, replacing $installedVersion"
}

$replaceFiles = (Resolve-Path $Source).Path.TrimEnd('\') -ne $InstallDir

# 1. Copy the package next to the program folder while the services still run: if this fails, nothing has changed.
if ($replaceFiles) {
    try {
        if (Test-Path $StagingDir) { Remove-Item -Recurse -Force $StagingDir }
        New-Item -ItemType Directory -Force $StagingDir | Out-Null
        Copy-Item -Recurse -Path (Join-Path $Source '*') -Destination $StagingDir
    } catch {
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $StagingDir
        throw "Copying the program files to $StagingDir failed, nothing was changed: $($_.Exception.Message)"
    }
}

# 2. Stop all instances (they all run from the program folder) and swap in the new program files.
$runningIds = @(Get-InstalledServiceIds | Where-Object { (Get-Service -Name $_).Status -eq 'Running' })
Stop-Instances (Get-InstalledServiceIds)
if ($replaceFiles) {
    try {
        if (Test-Path $PreviousDir) { Remove-Item -Recurse -Force $PreviousDir }
        if (Test-Path $InstallDir) { Rename-Item -Path $InstallDir -NewName (Split-Path -Leaf $PreviousDir) }
        Rename-Item -Path $StagingDir -NewName (Split-Path -Leaf $InstallDir)
    } catch {
        $reason = $_.Exception.Message
        # Put the old program files back (if they were moved already) and restart what ran before.
        if (-not (Test-Path $InstallDir) -and (Test-Path $PreviousDir)) {
            Rename-Item -Path $PreviousDir -NewName (Split-Path -Leaf $InstallDir)
        }
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $StagingDir
        foreach ($id in $runningIds) { Start-Service -Name $id -ErrorAction SilentlyContinue }
        throw ("Replacing $InstallDir failed, the previous version stays installed: $reason`n" +
            'A program or the virus scanner may have a file in it open; close it and run install.ps1 again.')
    }
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $PreviousDir
}

# 3. Data folders and the config of the instance being installed (never overwritten).
New-Item -ItemType Directory -Force $DataDir, $ServiceDir, $LogDir | Out-Null
$targetConfig = Get-ConfigPath $Instance
if (-not (Test-Path $targetConfig)) {
    Write-Host "  creating $targetConfig"
    $config = [ordered]@{
        driver          = 'ads'
        amsNetId        = $AmsNetId
        adsPort         = $AdsPort
        port            = $Port
        cycleMs         = 20
        configRecheckMs = 1000
        manifestPath    = 'GVL_Visu.stManifest'
    }
    Write-Utf8NoBom $targetConfig ($config | ConvertTo-Json)
}

# 4. Service wrapper (WinSW) per instance, registration, firewall rule, start.
#    WinSW v2 writes start mode, failure actions and names only on install, so existing services are registered again.
$failures = @()
$started = @()
foreach ($id in $serviceIds) {
    $name = Get-InstanceName $id
    $configPath = Get-ConfigPath $name
    if (-not (Test-Path $configPath)) { $failures += "$id has no config file $configPath"; continue }
    $esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
    $displayName = if ($name) { "RPP Visualisation ($name)" } else { 'RPP Visualisation' }
    $xml = @"
<service>
  <id>$id</id>
  <name>$(& $esc $displayName)</name>
  <description>Read-only web visualisation of the packaging machine. Config: $(& $esc $configPath)</description>
  <executable>$(& $esc (Join-Path $InstallDir 'node.exe'))</executable>
  <arguments>"$(& $esc (Join-Path $InstallDir 'gateway.mjs'))" --config "$(& $esc $configPath)"</arguments>
  <workingdirectory>$(& $esc $InstallDir)</workingdirectory>
  <startmode>Automatic</startmode>
  <priority>BelowNormal</priority>
  <onfailure action="restart" delay="10 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>10 sec</stoptimeout>
  <logpath>$(& $esc $LogDir)</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
</service>
"@
    try {
        $wrapper = Join-Path $ServiceDir "$id.exe"
        if (Get-Service -Name $id -ErrorAction SilentlyContinue) {
            Write-Host "  unregistering $id"
            $removed = $false
            if (Test-Path $wrapper) { & $wrapper uninstall | Out-Null; $removed = $LASTEXITCODE -eq 0 }
            if (-not $removed) { & sc.exe delete $id | Out-Null }
            $deadline = (Get-Date).AddSeconds(30)
            while (Get-Service -Name $id -ErrorAction SilentlyContinue) {
                if ((Get-Date) -gt $deadline) {
                    throw "Windows still lists $id as marked for deletion. Close the Services console (services.msc) and run install.ps1 again."
                }
                Start-Sleep -Milliseconds 500
            }
        }
        Copy-Item -Force (Join-Path $InstallDir 'winsw.exe') $wrapper
        Write-Utf8NoBom (Join-Path $ServiceDir "$id.xml") $xml
        Write-Host "  registering $id"
        & $wrapper install
        if ($LASTEXITCODE -ne 0) { throw "Registering $id failed (exit code $LASTEXITCODE)." }

        $httpPort = Get-HttpPort $configPath
        $rule = "RPP Visualisation ($id)"
        Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
        New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $httpPort -Action Allow -Profile Any | Out-Null

        Write-Host "  starting $id on port $httpPort"
        try {
            Start-Service -Name $id
        } catch {
            # Start-Service only says that it failed; the gateway's own message is in its error log.
            throw "$($_.Exception.Message) End of its error log:`n$(Get-ErrorLogTail $id)"
        }
        $started += @{ Id = $id; Port = $httpPort }
    } catch {
        $failures += "${id}: $($_.Exception.Message)"
    }
}

# 5. A started service may still end right away (broken config, port in use), and WinSW keeps restarting it, so the
#    service alone can look fine: each instance must answer on /health.
foreach ($check in $started) {
    $deadline = (Get-Date) + $HealthTimeout
    # Waits for 200: right after the start the gateway answers 503 until its first connection to the PLC.
    $health = $null
    while ((Get-Date) -lt $deadline) {
        $health = Get-Health $check.Port
        if ($health -and $health.Status -eq 200) { break }
        Start-Sleep -Seconds 1
    }
    if (-not $health) {
        $failures += ("$($check.Id) does not answer on http://localhost:$($check.Port)/health. " +
            "End of its error log:`n$(Get-ErrorLogTail $check.Id)")
    } elseif ($health.Status -ne 200) {
        $reasons = try {
            @(($health.Body | ConvertFrom-Json).sources | Where-Object { -not $_.plcConnected } |
                ForEach-Object { "$($_.name): $($_.lastError)" })
        } catch { @() }
        Write-Warning "$($check.Id) runs, but a PLC is not connected yet: $($reasons -join '; ')"
    }
}

if ($failures.Count -gt 0) {
    throw "Installed RPP visualisation $version, but these instances need attention (logs: $LogDir):`n  $($failures -join "`n  ")"
}
Write-Host "Done: RPP visualisation $version is installed. Open http://<ipc-address>:<port> from a browser on the machine network."
