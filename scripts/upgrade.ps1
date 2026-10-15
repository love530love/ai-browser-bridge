param(
  [switch]$ApplyGitUpdate,
  [switch]$BestEffort,
  [switch]$SkipReload,
  [int]$HealthTimeoutSec = 45
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$state = Join-Path $root '.local\upgrade'
New-Item -ItemType Directory -Force -Path $state | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$resultPath = Join-Path $state 'last-result.json'
$backupPath = Join-Path $state "backup-$stamp"
$result = [ordered]@{ startedAt=(Get-Date).ToString('o'); root=$root; appliedGitUpdate=$false; reload='skipped'; doctor=$null; ok=$false }

function Invoke-BridgeDoctor {
  $out = & $node (Join-Path $root 'src\cli.js') doctor 2>&1
  if ($LASTEXITCODE -ne 0) { throw "doctor failed: $out" }
  return ($out -join "`n" | ConvertFrom-Json)
}
function Save-Result($value) { $value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $resultPath -Encoding utf8 }

try {
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

  Push-Location $root
  try { & npm ci --ignore-scripts; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' } } finally { Pop-Location }
  & $pwsh -NoProfile -File (Join-Path $root 'start.ps1') | Out-Null
  if (-not $SkipReload) {
    & $pwsh -NoProfile -File (Join-Path $PSScriptRoot 'reload-extension.ps1') -BestEffort
    $result.reload = if ($LASTEXITCODE -eq 0) { 'attempted' } else { 'failed' }
  }
  $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
  do {
    Start-Sleep -Milliseconds 500
    try { $doctor = Invoke-BridgeDoctor; if ($doctor.ok) { break } } catch { $doctor = $null }
  } while ((Get-Date) -lt $deadline)
  if (-not $doctor) { throw 'doctor returned no report' }
  $result.doctor = $doctor
  if (-not $doctor.ok) { throw 'doctor reported unhealthy bridge' }
  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
  if ($backupPath -and (Test-Path -LiteralPath $backupPath)) { $result.backup = $backupPath }
  if (-not $BestEffort) { Save-Result $result; throw }
} finally {
  $result.finishedAt = (Get-Date).ToString('o')
  Save-Result $result
}
if (-not $result.ok -and -not $BestEffort) { exit 1 }
Write-Output ($result | ConvertTo-Json -Depth 12)
