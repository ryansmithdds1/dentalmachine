# Dental Machine imaging bridge - Windows uninstaller (run through uninstall.cmd).
# Removes the logon task, stops the bridge, and deletes the bridge program, its settings (which hold the
# workstation's key) and its log. Exported images in the Export folder are never deleted.
# Also remove the workstation in Dental Machine (Settings -> Imaging bridges) so its key stops working.
param([string]$InstallDir = 'C:\DentalMachine', [switch]$Elevated)
$ErrorActionPreference = 'Continue'
$taskName = 'Dental Machine imaging bridge'
function Finish([int]$code) {
  if ($Elevated) { Write-Host ''; Read-Host 'Press Enter to close this window' | Out-Null }
  exit $code
}
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host 'Asking Windows for administrator permission...'
  try {
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-InstallDir', "`"$InstallDir`"", '-Elevated') -Verb RunAs -Wait
  } catch {
    Write-Host 'Administrator permission was not given. Right-click uninstall.cmd and choose "Run as administrator".' -ForegroundColor Red
    exit 1
  }
  exit 0
}
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "  OK    Removed the logon task '$taskName'" -ForegroundColor Green
} else {
  Write-Host "  (no logon task '$taskName' was registered)"
}
# The task's keep-alive script and the bridge itself.
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*dental-machine-bridge.mjs*' -or $_.CommandLine -like '*run-bridge.ps1*' } | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
Write-Host '  OK    Stopped the bridge' -ForegroundColor Green
foreach ($f in @('dental-machine-bridge.mjs', 'presets.json', 'run-bridge.ps1', 'bridge-config.json', 'bridge-config.previous.json', 'bridge-state.json', 'bridge.log', 'bridge.log.old', 'SETUP.txt')) {
  $path = Join-Path $InstallDir $f
  if (Test-Path $path) { Remove-Item -Path $path -Force }
}
Write-Host "  OK    Removed the bridge program and its settings from $InstallDir" -ForegroundColor Green
if (Test-Path (Join-Path $InstallDir 'Export')) { Write-Host "  Images in $InstallDir\Export were left in place." }
Write-Host ''
Write-Host 'Last step: in Dental Machine, Settings -> Imaging bridges, remove this workstation so its key stops working.'
Write-Host "Node.js was left installed. You can delete $InstallDir once you no longer need anything in it."
Finish 0
