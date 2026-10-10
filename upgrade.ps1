# Stops and restarts the bridge service. If you also want the latest code, run
# `git pull` (or your package manager) and then this script.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$ps = if (Test-Path (Join-Path $PSScriptRoot 'stop.ps1')) { 'powershell.exe' } else { throw 'stop.ps1 missing' }

& $ps -NoProfile -File (Join-Path $root 'stop.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Stop failed' }
& $ps -NoProfile -File (Join-Path $root 'start.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Start failed' }
Write-Host 'Bridge restarted. Reconnect from the extension popup if needed.'