# Stops and restarts the bridge service. If you also want the latest code, run
# `git pull` (or your package manager) and then this script.
param(
  [int]$ChromeProcessId = 0,
  [long]$ChromeWindowHandle = 0
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$ps = if (Test-Path (Join-Path $PSScriptRoot 'stop.ps1')) { 'powershell.exe' } else { throw 'stop.ps1 missing' }

& $ps -NoProfile -File (Join-Path $root 'stop.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Stop failed' }
& $ps -NoProfile -File (Join-Path $root 'start.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Start failed' }
$reload = Join-Path $root 'scripts/reload-extension.ps1'
if (Test-Path $reload) {
  & (Get-Command pwsh.exe).Source -NoProfile -File $reload -ChromeProcessId $ChromeProcessId -ChromeWindowHandle $ChromeWindowHandle -BestEffort
  $reloadExitCode = $LASTEXITCODE
  if ($reloadExitCode -eq 3) {
    Write-Warning 'Extension reload outcome is uncertain. Inspect the extension connection and version before deciding whether to retry.'
  } elseif ($reloadExitCode -eq 2) {
    Write-Warning 'Extension reload was not dispatched. No Chrome window or unique Reload control was identified.'
  } elseif ($reloadExitCode -ne 0) {
    Write-Warning "Extension reload returned exit code $reloadExitCode; treat its outcome as uncertain and inspect state before retrying."
  }
}
Write-Host 'Bridge restarted. Extension reload was attempted at most once.'
