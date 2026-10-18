param(
  [switch]$ApplyGitUpdate,
  [switch]$BestEffort,
  [switch]$SkipReload,
  [ValidateRange(1, 600)][int]$HealthTimeoutSec = 45
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
. (Join-Path $PSScriptRoot 'bounded-process.ps1')
$state = Join-Path $root '.local\upgrade'
New-Item -ItemType Directory -Force -Path $state | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$resultPath = Join-Path $state 'last-result.json'
$backupPath = Join-Path $state "backup-$stamp"
$result = [ordered]@{ startedAt=(Get-Date).ToString('o'); root=$root; appliedGitUpdate=$false; reload='skipped'; reloadAttempts=0; doctor=$null; ok=$false }
$maintenanceToken = $null
function Invoke-Maintenance($payload) {
  $config = Get-Content -LiteralPath (Join-Path $root '.local/config.json') -Raw | ConvertFrom-Json
  Invoke-RestMethod -Uri "http://127.0.0.1:$($config.port)/maintenance" -Method Post -Headers @{ Authorization = "Bearer $($config.agentToken)" } -ContentType 'application/json' -Body ($payload | ConvertTo-Json -Compress) -TimeoutSec 10
}

function Invoke-BridgeDoctor {
  $out = & $node (Join-Path $root 'src\cli.js') doctor 2>&1
  if ($LASTEXITCODE -ne 0) { throw "doctor failed: $out" }
  return ($out -join "`n" | ConvertFrom-Json)
}
function Save-Result($value) { $value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $resultPath -Encoding utf8 }

try {
  # Read first, then atomically close admission on servers supporting maintenance.
  $preflight = Invoke-BridgeDoctor
  $result.preflight = $preflight
  if ($preflight.status -and ($preflight.status.active -or $preflight.status.queued -gt 0 -or $preflight.status.taskLease -or $preflight.status.tabLeases.Count -gt 0)) {
    $result.status = 'waiting'
    $result.actionRequired = 'wait-for-idle'
    throw 'Bridge has pending work or leases. Preserve agent tasks and retry upgrade after work finishes.'
  }
  if ($preflight.status) {
    $gate = Invoke-Maintenance @{ action='acquire'; ttlMs=600000 }
    if ($gate.status -ne 'acquired') {
      $result.status = 'waiting'
      $result.actionRequired = 'wait-for-idle'
      throw 'Maintenance acquisition deferred; no upgrade changes applied.'
    }
    $maintenanceToken = $gate.token
    $result.maintenanceExpiresAt = $gate.expiresAt
  }
  if ($ApplyGitUpdate) {
    $head = (& git -C $root rev-parse HEAD).Trim()
    New-Item -ItemType Directory -Force -Path $backupPath | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination $backupPath -Force
    Copy-Item -LiteralPath (Join-Path $root 'package-lock.json') -Destination $backupPath -Force
    & git -C $root fetch --prune
    if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }
    & git -C $root pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw 'git pull --ff-only failed; local changes were not overwritten' }
    $result.appliedGitUpdate = $true
    $result.previousHead = $head
  }

  if ($maintenanceToken -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 300000 -ge $result.maintenanceExpiresAt) {
    throw 'Not enough maintenance time remains to install dependencies safely; retry upgrade in a new window.'
  }
  Invoke-BoundedProcess -FilePath $pwsh -ArgumentList @('-NoProfile', '-Command', '& npm ci --ignore-scripts; exit $LASTEXITCODE') -WorkingDirectory $root -TimeoutSec 240
  & $pwsh -NoProfile -File (Join-Path $root 'start.ps1') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Bridge startup failed; extension reload was not attempted.' }
  $started = Invoke-BridgeDoctor
  if ($maintenanceToken -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $result.maintenanceExpiresAt) {
    throw 'Maintenance window expired; extension reload was not attempted. Recheck tasks before continuing.'
  }
  $deployment = $started.checks | Where-Object name -eq 'deployment-current' | Select-Object -First 1
  if ($deployment -and $deployment.serviceVersion -ne $deployment.expectedVersion) {
    $result.doctor = $started
    $result.status = 'waiting'
    $result.actionRequired = 'restart-service-when-idle'
    throw 'Existing service is running old code. Restart it during an idle maintenance window, then rerun upgrade.'
  }
  if (-not $SkipReload) {
    for ($attempt = 1; $attempt -le 2; $attempt++) {
      $result.reloadAttempts = $attempt
      & $pwsh -NoProfile -File (Join-Path $PSScriptRoot 'reload-extension.ps1') -BestEffort
      if ($LASTEXITCODE -eq 0) { $result.reload = 'attempted'; break }
      $result.reload = 'failed'
      Start-Sleep -Seconds 1
    }
  }
  $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
  do {
    Start-Sleep -Milliseconds 500
    try { $doctor = Invoke-BridgeDoctor; if ($doctor.ok) { break } } catch { $doctor = $null }
  } while ((Get-Date) -lt $deadline)
  if (-not $doctor) { throw 'doctor returned no report' }
  $result.doctor = $doctor
  if (-not $doctor.ok) {
    $deployment = $doctor.checks | Where-Object name -eq 'deployment-current' | Select-Object -First 1
    if ($deployment -and $deployment.extensionVersion -ne $deployment.manifestVersion) {
      $result.actionRequired = 'manual-extension-reload'
    }
    throw 'doctor reported unhealthy bridge'
  }
  $result.ok = $true
  $result.status = 'complete'
} catch {
  $result.error = $_.Exception.Message
  if ($backupPath -and (Test-Path -LiteralPath $backupPath)) { $result.backup = $backupPath }
  if (-not $BestEffort) { Save-Result $result; throw }
} finally {
  if ($maintenanceToken) {
    try { $null = Invoke-Maintenance @{ action='release'; token=$maintenanceToken } }
    catch { $result.maintenanceRelease = 'not-confirmed; lock expires automatically' }
  }
  $result.finishedAt = (Get-Date).ToString('o')
  Save-Result $result
}
Write-Output ($result | ConvertTo-Json -Depth 12)
if (-not $result.ok) { exit 1 }
