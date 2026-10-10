# Remove the auto-start registration installed by install-autostart.ps1.
# Clears every method (startup shortcut, registry entry) and the generated
# launcher files, so re-running install-autostart.ps1 starts from clean slate.
# Idempotent: returns success whether anything was registered or not.
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$removed = @()

# 1) Startup folder shortcut (default method).
$startupDir = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startupDir 'AI Browser Bridge.lnk'
if (Test-Path -LiteralPath $lnkPath) {
  Remove-Item -LiteralPath $lnkPath -Force
  $removed += "startup shortcut: $lnkPath"
}

# 2) HKCU Run entry (Registry method).
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$valueName = 'AIBrowserBridge'
if (Get-ItemProperty -LiteralPath $runKey -Name $valueName -ErrorAction SilentlyContinue) {
  Remove-ItemProperty -LiteralPath $runKey -Name $valueName -ErrorAction Stop
  $removed += "registry entry: HKCU\...\Run\$valueName"
}

# 3) Generated launcher files and the recorded node path.
foreach ($relative in @('bridge-autostart.vbs', 'bridge-autostart.cmd')) {
  $path = Join-Path $root $relative
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Force
    $removed += "launcher: $relative"
  }
}
$nodePathFile = Join-Path $root '.local\node-path.txt'
if (Test-Path -LiteralPath $nodePathFile) {
  Remove-Item -LiteralPath $nodePathFile -Force
  $removed += 'recorded node path'
}

if ($removed.Count -eq 0) {
  Write-Host 'No auto-start registration was found. Nothing to remove.'
} else {
  Write-Host 'Removed:'
  foreach ($item in $removed) { Write-Host ("  - {0}" -f $item) }
}

Write-Host ''
Write-Host 'The bridge service will no longer auto-start at logon.'
Write-Host 'A service started earlier is still running; stop it with stop.ps1 if needed.'
Write-Host 'Your pairing key, upload roots and agent policy are kept in .local/ and are untouched.'
