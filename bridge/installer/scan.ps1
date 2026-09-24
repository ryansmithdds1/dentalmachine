# Dental Machine bridge: scan on this PC's scanner through Windows Image Acquisition (WIA 2.0).
# Called by dental-machine-bridge.mjs when "Scan" is pressed in a chart; writes one JPEG per page into -OutDir
# (page-001.jpg, page-002.jpg, …). The bridge makes the PDF and files it to the patient.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scan.ps1 -List
#   powershell -NoProfile -ExecutionPolicy Bypass -File scan.ps1 -OutDir C:\Temp\scan -Source feeder -Duplex -Color gray -Dpi 300
#
# UNTESTED ON REAL HARDWARE. Written from Microsoft's WIA 2.0 automation documentation (WIA.DeviceManager,
# Item.Transfer, WIA property ids below). Scanners differ in what they report: if a feeder scan returns only one
# page or fails, try -Source flatbed, check the scanner's own WIA driver is installed (not just TWAIN), and run
# -List. ScanSnap models have no WIA driver: use a "scan folder" instead (see docs/documents.md).
param(
  [string]$OutDir = "$env:TEMP\dm-scan",
  [ValidateSet('auto', 'flatbed', 'feeder')][string]$Source = 'auto',
  [switch]$Duplex,
  [ValidateSet('color', 'gray', 'bw')][string]$Color = 'gray',
  [int]$Dpi = 300,
  [string]$Device = '',
  [switch]$List
)
$ErrorActionPreference = 'Stop'

# WIA constants
$ScannerDeviceType = 1
$WIA_DPS_DOCUMENT_HANDLING_CAPABILITIES = 3086
$WIA_DPS_DOCUMENT_HANDLING_STATUS = 3087
$WIA_DPS_DOCUMENT_HANDLING_SELECT = 3088
$WIA_DPS_PAGES = 3096
$WIA_IPS_CUR_INTENT = 6146
$WIA_IPS_XRES = 6147
$WIA_IPS_YRES = 6148
$FEEDER = 1; $FLATBED = 2; $DUPLEX = 4; $FEED_READY = 1
$FormatJPEG = '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}'
$WIA_ERROR_PAPER_EMPTY = 0x80210003

function Set-Prop($props, [int]$id, $value) {
  foreach ($p in $props) {
    if ($p.PropertyID -eq $id) {
      try { $p.Value = $value; return $true } catch { return $false }
    }
  }
  return $false
}
function Get-Prop($props, [int]$id) {
  foreach ($p in $props) { if ($p.PropertyID -eq $id) { return $p.Value } }
  return $null
}

$manager = New-Object -ComObject WIA.DeviceManager
$scanners = @($manager.DeviceInfos | Where-Object { $_.Type -eq $ScannerDeviceType })

if ($List) {
  if (-not $scanners.Count) { Write-Output 'No WIA scanners found. Install the scanner''s WIA driver (TWAIN-only scanners won''t show here).'; exit 0 }
  foreach ($s in $scanners) {
    $name = ($s.Properties | Where-Object { $_.Name -eq 'Name' }).Value
    Write-Output "$name  (id $($s.DeviceID))"
  }
  exit 0
}

if (-not $scanners.Count) { Write-Error 'No WIA scanner found on this computer — is it plugged in and switched on?'; exit 2 }
$info = $scanners[0]
if ($Device) {
  $match = $scanners | Where-Object { ($_.Properties | Where-Object { $_.Name -eq 'Name' }).Value -like "*$Device*" -or $_.DeviceID -eq $Device } | Select-Object -First 1
  if (-not $match) { Write-Error "No WIA scanner named '$Device' (run scan.ps1 -List)"; exit 2 }
  $info = $match
}
$dev = $info.Connect()

# Where the paper comes from. "auto": the feeder when it has paper in it, else the glass.
$caps = Get-Prop $dev.Properties $WIA_DPS_DOCUMENT_HANDLING_CAPABILITIES
$hasFeeder = $caps -ne $null -and (($caps -band $FEEDER) -ne 0)
$useFeeder = $false
if ($Source -eq 'feeder') {
  if (-not $hasFeeder) { Write-Error 'This scanner has no document feeder'; exit 3 }
  $useFeeder = $true
} elseif ($Source -eq 'auto' -and $hasFeeder) {
  $status = Get-Prop $dev.Properties $WIA_DPS_DOCUMENT_HANDLING_STATUS
  $useFeeder = $status -ne $null -and (($status -band $FEED_READY) -ne 0)
}
if ($useFeeder) {
  $select = $FEEDER
  if ($Duplex -and (($caps -band $DUPLEX) -ne 0)) { $select = $FEEDER -bor $DUPLEX }
  [void](Set-Prop $dev.Properties $WIA_DPS_DOCUMENT_HANDLING_SELECT $select)
  [void](Set-Prop $dev.Properties $WIA_DPS_PAGES 1)
} elseif ($hasFeeder) {
  [void](Set-Prop $dev.Properties $WIA_DPS_DOCUMENT_HANDLING_SELECT $FLATBED)
}

$item = $dev.Items.Item(1)
$intent = @{ color = 1; gray = 2; bw = 4 }[$Color]
[void](Set-Prop $item.Properties $WIA_IPS_CUR_INTENT $intent)
[void](Set-Prop $item.Properties $WIA_IPS_XRES $Dpi)
[void](Set-Prop $item.Properties $WIA_IPS_YRES $Dpi)

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$page = 0
$process = New-Object -ComObject WIA.ImageProcess
[void]$process.Filters.Add($process.FilterInfos.Item('Convert').FilterID)
$process.Filters.Item(1).Properties.Item('FormatID').Value = $FormatJPEG
$process.Filters.Item(1).Properties.Item('Quality').Value = 85

while ($true) {
  try {
    $image = $item.Transfer($FormatJPEG)
  } catch {
    $code = $_.Exception.HResult
    if ($page -gt 0 -and ($code -eq $WIA_ERROR_PAPER_EMPTY -or $code -eq -2145320957)) { break }
    if ($page -eq 0 -and ($code -eq $WIA_ERROR_PAPER_EMPTY -or $code -eq -2145320957)) { Write-Error 'The feeder is empty — put the pages in and scan again'; exit 4 }
    Write-Error "Scan failed: $($_.Exception.Message)"
    exit 5
  }
  # Some drivers ignore the requested format: convert to JPEG so the bridge can build the PDF.
  if ($image.FormatID -ne $FormatJPEG) { $image = $process.Apply($image) }
  $page++
  $path = Join-Path $OutDir ('page-{0:D3}.jpg' -f $page)
  if (Test-Path $path) { Remove-Item $path -Force }
  $image.SaveFile($path)
  Write-Output "page $page -> $path"
  if (-not $useFeeder) { break }
}
Write-Output "done $page"
exit 0
