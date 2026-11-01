<#
.SYNOPSIS
    Removes the RPP visualisation services.

.DESCRIPTION
    Without -Instance: removes every RPP_Visualisation service, its firewall rule and service wrapper, and
    C:\Program Files\RPP_Visualisation\. With -Instance: removes only that instance and keeps the program files.
    C:\ProgramData\RPP_Visualisation\ (config and logs) is kept unless -RemoveData is passed.

.PARAMETER Instance
    Remove only this additional instance, e.g. "852". Use "default" for the default instance.

.PARAMETER RemoveData
    Also delete the config and logs: the whole data folder, or only the instance's config file with -Instance.

.EXAMPLE
    & "C:\Program Files\RPP_Visualisation\uninstall.ps1"

.EXAMPLE
    & "C:\Program Files\RPP_Visualisation\uninstall.ps1" -Instance 852
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9-]*$')]
    [string]$Instance = '',
    [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'
$Product = 'RPP_Visualisation'
$InstallDir = Join-Path $env:ProgramFiles $Product
$DataDir = Join-Path $env:ProgramData $Product
$ServiceDir = Join-Path $DataDir 'service'

function Remove-Instance([string]$Id) {
    Write-Host "  removing $Id"
    $service = Get-Service -Name $Id -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne 'Stopped') {
        Stop-Service -Name $Id -Force
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    $wrapper = Join-Path $ServiceDir "$Id.exe"
    if ($service) {
        if (Test-Path $wrapper) { & $wrapper uninstall | Out-Null } else { & sc.exe delete $Id | Out-Null }
    }
    Remove-Item -Force -ErrorAction SilentlyContinue $wrapper, (Join-Path $ServiceDir "$Id.xml")
    Get-NetFirewallRule -DisplayName "RPP Visualisation ($Id)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}

# The script may live in the folder it deletes.
Set-Location $env:TEMP

if ($Instance) {
    $id = if ($Instance -eq 'default') { $Product } else { "${Product}_$Instance" }
    Remove-Instance $id
    if ($RemoveData) {
        $config = if ($Instance -eq 'default') { 'config.json' } else { "config-$Instance.json" }
        Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $DataDir $config)
    }
} else {
    Get-Service -Name "$Product*" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "^$Product(_[A-Za-z0-9-]+)?$" } |
        ForEach-Object { Remove-Instance $_.Name }
    # With what an interrupted install.ps1 may have left next to it.
    foreach ($dir in $InstallDir, "$InstallDir.new", "$InstallDir.old") {
        if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    }
    if ($RemoveData -and (Test-Path $DataDir)) { Remove-Item -Recurse -Force $DataDir }
}

Write-Host 'Done.'
