# Stops the bridge service. Looks up the node process by port (19387 by default)
# rather than a PID file, because the auto-start launcher never writes one.
# If the service was started by .\start.ps1 the PID file is still updated and
# used first as a fast path.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$port = 19387
$configPath = Join-Path $root '.local\config.json'
if (Test-Path -LiteralPath $configPath) {
  try { $port = ([int](Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).port) } catch {}
}
$expectedScript = Join-Path $root 'src\server.js'

function Get-BridgeProcess {
  $cim = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $cim) {
    if ($p.CommandLine -and $p.CommandLine.Contains($expectedScript)) { return $p }
  }
  $net = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($net) {
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $($net.OwningProcess)" -ErrorAction SilentlyContinue
    if ($cim -and $cim.CommandLine -and $cim.CommandLine.Contains($expectedScript)) { return $cim }
  }
  return $null
}

$pidFile = Join-Path $root '.local\server.pid'
if (Test-Path -LiteralPath $pidFile) {
  $stored = [int](Get-Content -LiteralPath $pidFile -Raw)
  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $stored" -ErrorAction SilentlyContinue
  if ($p -and $p.CommandLine -and $p.CommandLine.Contains($expectedScript)) { Stop-Process -Id $stored; Write-Host 'Bridge stopped.'; exit 0 }
}

$process = Get-BridgeProcess
if (-not $process) { Write-Host 'No bridge service is currently running.'; exit 0 }

Stop-Process -Id $process.ProcessId
Write-Host 'Bridge stopped. Any in-flight browser action may already have run; inspect the page before retrying.'