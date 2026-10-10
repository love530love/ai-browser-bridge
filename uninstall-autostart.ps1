# Remove the auto-start registration installed by install-autostart.ps1.
# Idempotent: returns success whether the entry existed or not.
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$valueName = 'AIBrowserBridge'

$existing = Get-ItemProperty -LiteralPath $runKey -Name $valueName -ErrorAction SilentlyContinue
if ($existing) {
  Remove-ItemProperty -LiteralPath $runKey -Name $valueName -ErrorAction Stop
  Write-Host ("Removed: HKCU\...\Run\{0}" -f $valueName)
} else {
  Write-Host 'No registry entry was present.'
}

$vbs = Join-Path $root 'bridge-autostart.vbs'
if (Test-Path -LiteralPath $vbs) {
  Remove-Item -LiteralPath $vbs -Force
  Write-Host ("Removed launcher: {0}" -f $vbs)
}

Write-Host 'The bridge service will no longer auto-start at logon.'
Write-Host 'Start it manually with .\start.ps1 if you still need it.'