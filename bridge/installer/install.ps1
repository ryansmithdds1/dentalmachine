# Dental Machine imaging bridge - Windows installer (run through install.cmd).
#
# What it does, in order:
#   1. Asks for administrator permission (needed to install Node.js and register the logon task).
#   2. Installs Node.js LTS if it's missing or older than 18: winget first, else the official MSI from
#      nodejs.org (checked against nodejs.org's SHA-256 list). If both fail it says what to do and stops.
#   3. Copies the bridge, presets.json and bridge-config.json to C:\DentalMachine (keeps a copy of an older
#      bridge-config.json) and limits that folder to administrators and the person the bridge runs as,
#      because bridge-config.json holds the workstation's key.
#   4. Registers a Scheduled Task that starts the bridge (hidden) when that person signs in to Windows,
#      and restarts it if it stops. Why a logon task and not a Windows service: services run in a
#      separate, invisible session and can't open DEXIS, Sidexis and the like on the operatory screen.
#   5. Runs the bridge's own setup check (--check), prints the results, and starts the bridge.
#
# Options: -InstallDir D:\DentalMachine    install somewhere else
#          -AllUsers                       start the bridge for whoever signs in (shared operatory logins)
param(
  [string]$RunAsUser = "$env:USERDOMAIN\$env:USERNAME",
  [string]$InstallDir = 'C:\DentalMachine',
  [switch]$AllUsers,
  [switch]$Elevated
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'Dental Machine imaging bridge'

function Say([string]$m) { Write-Host $m }
function Good([string]$m) { Write-Host "  OK    $m" -ForegroundColor Green }
function Bad([string]$m) { Write-Host "  FAIL  $m" -ForegroundColor Red }
function Finish([int]$code) {
  if ($Elevated) { Write-Host ''; Read-Host 'Press Enter to close this window' | Out-Null }
  exit $code
}

# ---- 1. Administrator permission ----
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Say 'Asking Windows for administrator permission...'
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-RunAsUser', "`"$RunAsUser`"", '-InstallDir', "`"$InstallDir`"", '-Elevated')
  if ($AllUsers) { $argList += '-AllUsers' }
  try {
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -Wait
  } catch {
    Bad 'Administrator permission was not given. Right-click install.cmd and choose "Run as administrator", or ask your IT person.'
    exit 1
  }
  exit 0
}

Say ''
Say 'Dental Machine imaging bridge - installing'
Say "  Folder:  $InstallDir"
Say "  Runs as: $(if ($AllUsers) { 'whoever signs in to this PC' } else { $RunAsUser })"
Say ''

# Files downloaded from the internet are marked as such; unblock ours so Windows doesn't stop them.
Get-ChildItem -Path $here -File | Unblock-File -ErrorAction SilentlyContinue

foreach ($f in @('dental-machine-bridge.mjs', 'presets.json', 'bridge-config.json', 'run-bridge.ps1')) {
  if (-not (Test-Path (Join-Path $here $f))) { Bad "$f is missing from this folder. Unzip the whole package first, then run install.cmd from the unzipped folder."; Finish 1 }
}

# ---- 2. Node.js ----
function Find-Node {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}
function Node-Major([string]$node) {
  try { return [int]((& $node --version).TrimStart('v').Split('.')[0]) } catch { return 0 }
}
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }

$node = Find-Node
if (-not $node -or (Node-Major $node) -lt 18) {
  Say 'Node.js 18 or newer is needed. Installing Node.js LTS...'
  if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
    & winget.exe install --id OpenJS.NodeJS.LTS -e --silent --scope machine --accept-package-agreements --accept-source-agreements | Out-Host
    Refresh-Path
    $node = Find-Node
  }
  if (-not $node -or (Node-Major $node) -lt 18) {
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $lts = (Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing) | Where-Object { $_.lts } | Select-Object -First 1
      $ver = $lts.version
      $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } elseif ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
      $msiName = "node-$ver-$arch.msi"
      $msi = Join-Path $env:TEMP $msiName
      Say "Downloading $msiName from nodejs.org..."
      Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/$msiName" -OutFile $msi -UseBasicParsing
      $sums = [string](Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/SHASUMS256.txt" -UseBasicParsing).Content
      $line = ($sums -split "`n") | Where-Object { $_.Trim().EndsWith("  $msiName") } | Select-Object -First 1
      $expected = if ($line) { ($line.Trim() -split '\s+')[0].ToLower() } else { '' }
      $actual = (Get-FileHash -Path $msi -Algorithm SHA256).Hash.ToLower()
      if (-not $expected -or $expected -ne $actual) { throw "the download didn't match nodejs.org's checksum" }
      $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart') -Wait -PassThru
      if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "the Node.js installer stopped with code $($p.ExitCode)" }
      Refresh-Path
      $node = Find-Node
    } catch {
      Bad "Couldn't install Node.js automatically ($($_.Exception.Message))."
    }
  }
  if (-not $node -or (Node-Major $node) -lt 18) {
    Bad 'Node.js is not installed. Download the "LTS" Windows installer from https://nodejs.org, install it with the default options, then run install.cmd again.'
    Finish 1
  }
}
Good "Node.js $(& $node --version) at $node"

# ---- 3. Copy the bridge ----
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
# Stop a running copy first (reinstalling or updating).
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*dental-machine-bridge.mjs*' } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
$cfg = Join-Path $InstallDir 'bridge-config.json'
if ((Test-Path $cfg) -and ((Resolve-Path $here).Path -ne (Resolve-Path $InstallDir).Path)) {
  Copy-Item $cfg (Join-Path $InstallDir 'bridge-config.previous.json') -Force
  Say '  (the old bridge-config.json was kept as bridge-config.previous.json)'
}
if ((Resolve-Path $here).Path -ne (Resolve-Path $InstallDir).Path) {
  foreach ($f in @('dental-machine-bridge.mjs', 'presets.json', 'bridge-config.json', 'run-bridge.ps1', 'uninstall.cmd', 'uninstall.ps1', 'SETUP.txt')) {
    if (Test-Path (Join-Path $here $f)) { Copy-Item (Join-Path $here $f) (Join-Path $InstallDir $f) -Force }
  }
}
# The folder holds the workstation's key: administrators, SYSTEM and the person the bridge runs as only.
$who = if ($AllUsers) { '*S-1-5-32-545' } else { $RunAsUser }
& icacls.exe $InstallDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "${who}:(OI)(CI)M" | Out-Null
if ($LASTEXITCODE -ne 0) { Bad "Couldn't set permissions on $InstallDir (icacls exit code $LASTEXITCODE). Check that '$who' is a real Windows account." ; Finish 1 }
Good "Bridge copied to $InstallDir"

# ---- 4. Logon task ----
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$InstallDir\run-bridge.ps1`"" -WorkingDirectory $InstallDir
if ($AllUsers) {
  $users = (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')).Translate([Security.Principal.NTAccount]).Value
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal -GroupId $users -RunLevel Limited
} else {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $RunAsUser
  $principal = New-ScheduledTaskPrincipal -UserId $RunAsUser -LogonType Interactive -RunLevel Limited
}
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Opens imaging programs from the Dental Machine chart and sends new x-rays and photos to the chart.' -Force | Out-Null
  Good "Starts automatically when $(if ($AllUsers) { 'anyone' } else { $RunAsUser }) signs in (Task Scheduler: '$taskName')"
} catch {
  Bad "Couldn't register the logon task ($($_.Exception.Message))."
  Finish 1
}

# ---- 5. Setup check, then start ----
Say ''
Say 'Checking the setup (programs, export folders, sensor):'
# (Windows PowerShell turns a native program's error output into errors; don't let that stop the installer.)
$ErrorActionPreference = 'Continue'
$out = & $node (Join-Path $InstallDir 'dental-machine-bridge.mjs') $cfg --check 2>&1
$checkCode = $LASTEXITCODE
foreach ($l in $out) {
  $s = [string]$l
  if ($s.StartsWith('FAIL')) { Write-Host "  $s" -ForegroundColor Red } elseif ($s.StartsWith('NOTE')) { Write-Host "  $s" -ForegroundColor Yellow } else { Write-Host "  $s" }
}
try { Start-ScheduledTask -TaskName $taskName; Good 'Bridge started' } catch { Say "  The bridge will start the next time $RunAsUser signs in." }

Say ''
if ($checkCode -eq 0) {
  Good 'All checks passed. In Dental Machine, Settings -> Imaging bridges should show this workstation Online within a minute.'
} else {
  Say 'Some checks failed (above). The bridge is installed and running; fix the items marked FAIL'
  Say "(usually the imaging program's path in $cfg), then run install.cmd again or restart the PC."
  Say 'The same problems show in Dental Machine under Settings -> Imaging bridges and Needs attention.'
}
Say "Log file: $InstallDir\bridge.log"
if (Test-Path (Join-Path $InstallDir 'SETUP.txt')) { Say "Next steps for your imaging programs: $InstallDir\SETUP.txt" }
Finish 0
