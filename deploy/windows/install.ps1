<#
.SYNOPSIS
    Installs or updates the RPP visualisation as a Windows service.

.DESCRIPTION
    Run from the unzipped package in an elevated PowerShell.

    - Stops every installed RPP_Visualisation service.
    - Replaces C:\Program Files\RPP_Visualisation\ with this package.
    - Creates C:\ProgramData\RPP_Visualisation\config.json (or config-<Instance>.json) if it is missing.
      An existing config file is never changed.
    - Registers the service (automatic start, restart after a crash, priority BelowNormal). Every other installed
      instance is registered again too, so service settings from the new package take effect everywhere.
    - Adds a firewall rule for each instance's HTTP port.
    - Starts all instances. If one fails, the others are still started and the script reports the failure.

    Running it from an older package rolls back. Logs: C:\ProgramData\RPP_Visualisation\logs\.

.PARAMETER Instance
    Name of an additional instance for another PLC runtime on the same IPC, e.g. "852".
    The service is then RPP_Visualisation_<Instance> with config-<Instance>.json.
    Leave empty for the default instance. "default" is reserved.

.PARAMETER AdsPort
    ADS port of the PLC runtime, written only into a newly created config file. Default: 851.
    Required for a new additional instance.

.PARAMETER Port
    HTTP port of the page, written only into a newly created config file. Default: 8080.
    Required for a new additional instance, so it does not collide with the default instance.

.EXAMPLE
    .\install.ps1

.EXAMPLE
    .\install.ps1 -Instance 852 -AdsPort 852 -Port 8081
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9-]*$')]
    [string]$Instance = '',
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

foreach ($file in 'node.exe', 'gateway.mjs', 'AdsBridge.exe', 'winsw.exe', 'web') {
    if (-not (Test-Path (Join-Path $Source $file))) { throw "Package incomplete: $file is missing next to install.ps1." }
}
if ($Instance -eq 'default') { throw '"default" is reserved for the default instance; leave -Instance empty.' }
if ($Instance -and -not (Test-Path (Get-ConfigPath $Instance)) -and
    -not ($PSBoundParameters.ContainsKey('Port') -and $PSBoundParameters.ContainsKey('AdsPort'))) {
    throw "A new instance needs its own ports: pass -AdsPort and -Port, e.g. -Instance $Instance -AdsPort 852 -Port 8081."
}
$version = (Get-Content -Raw (Join-Path $Source 'VERSION')).Trim()
$targetId = Get-ServiceId $Instance
$serviceIds = @(Get-InstalledServiceIds)
if ($serviceIds -notcontains $targetId) { $serviceIds += $targetId }

Write-Host "Installing RPP visualisation $version"

# 1. Stop all instances: they all run from the program folder that is about to be replaced.
foreach ($id in Get-InstalledServiceIds) {
    Write-Host "  stopping $id"
    Stop-Service -Name $id -Force
    (Get-Service -Name $id).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
}

# 2. Replace the program files.
if ((Resolve-Path $Source).Path.TrimEnd('\') -ne $InstallDir) {
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    New-Item -ItemType Directory -Force $InstallDir | Out-Null
    Copy-Item -Recurse -Path (Join-Path $Source '*') -Destination $InstallDir
}

# 3. Data folders and the config of the instance being installed (never overwritten).
New-Item -ItemType Directory -Force $DataDir, $ServiceDir, $LogDir | Out-Null
$targetConfig = Get-ConfigPath $Instance
if (-not (Test-Path $targetConfig)) {
    Write-Host "  creating $targetConfig"
    $config = [ordered]@{
        driver          = 'ads'
        amsNetId        = '127.0.0.1.1.1'
        adsPort         = $AdsPort
        port            = $Port
        cycleMs         = 20
        configRecheckMs = 1000
    }
    Write-Utf8NoBom $targetConfig ($config | ConvertTo-Json)
}

# 4. Service wrapper (WinSW) per instance, registration, firewall rule, start.
#    WinSW v2 writes start mode, failure actions and names only on install, so existing services are registered again.
$failures = @()
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
        Start-Service -Name $id
    } catch {
        $failures += "${id}: $($_.Exception.Message)"
    }
}

if ($failures.Count -gt 0) {
    throw "Installed RPP visualisation $version, but these instances need attention (logs: $LogDir):`n  $($failures -join "`n  ")"
}
Write-Host "Done. Open http://<ipc-address>:<port> from a browser on the machine network."
