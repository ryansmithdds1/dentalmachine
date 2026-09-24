# Keeps the Dental Machine imaging bridge running for the signed-in person (started, hidden, by the
# "Dental Machine imaging bridge" logon task that install.cmd registers). Output goes to bridge.log next to
# this file; the log is rolled over at 5 MB. If the bridge stops it is restarted: after 10 seconds normally,
# after a minute when it stopped with an error (server unreachable at start-up, a revoked key, a broken
# bridge-config.json), so a bad key does not hammer the server.
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $here 'bridge.log'
function Find-Node {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}
function Note([string]$m) { Add-Content -Path $log -Value "$(Get-Date -Format s) $m" }
while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item -Path $log -Destination "$log.old" -Force }
  $node = Find-Node
  if (-not $node) { Note 'Node.js was not found - run install.cmd again'; Start-Sleep -Seconds 300; continue }
  # cmd.exe does the redirection so the log stays plain text (Windows PowerShell would write UTF-16).
  $line = '""{0}" "{1}" "{2}" >> "{3}" 2>&1"' -f $node, (Join-Path $here 'dental-machine-bridge.mjs'), (Join-Path $here 'bridge-config.json'), $log
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $line) -WorkingDirectory $here -WindowStyle Hidden -Wait -PassThru
  Note "Bridge stopped (exit code $($p.ExitCode)); restarting"
  if ($p.ExitCode -eq 1) { Start-Sleep -Seconds 60 } else { Start-Sleep -Seconds 10 }
}
