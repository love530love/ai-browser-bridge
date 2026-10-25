param([ValidateRange(1, 30)][int]$ProbeTimeoutSec = 8)
$ErrorActionPreference = 'Stop'
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = (Get-Command pwsh.exe -ErrorAction Stop).Source
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
foreach ($arg in @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'scripts/probe-service-process.ps1'))) { $info.ArgumentList.Add($arg) }
$probe = [Diagnostics.Process]::new()
$probe.StartInfo = $info
try {
  if (-not $probe.Start()) { throw 'Could not start service identity query.' }
  $stdout = $probe.StandardOutput.ReadToEndAsync()
  $stderr = $probe.StandardError.ReadToEndAsync()
  if (-not $probe.WaitForExit($ProbeTimeoutSec * 1000)) {
    $probe.Kill($true)
    if (-not $probe.WaitForExit(3000)) { throw 'Identity query timed out and could not be terminated. Service was not touched.' }
    throw 'Service identity query timed out. Only this query was stopped; service and recovery were not changed.'
  }
  if ($probe.ExitCode -ne 0) { throw "Service identity query failed with exit code $($probe.ExitCode). Service was not touched." }
  $result = $stdout.GetAwaiter().GetResult() | ConvertFrom-Json
  if (@($result.matches).Count -ne 1) { throw 'Expected exactly one verified bridge process. Service and recovery were not changed.' }
  $identity = $result.matches[0]
  $service = Get-Process -Id $identity.id -ErrorAction Stop
  try {
    $expectedTicks = [long]$identity.startedTicks
    if ($service.ProcessName -ne 'node' -or [Math]::Abs($service.StartTime.ToUniversalTime().Ticks - $expectedTicks) -gt 20000) { throw 'Service process identity changed. No process was stopped.' }
    $pause = Join-Path $PSScriptRoot '.local/service-paused'
    $alreadyPaused = Test-Path -LiteralPath $pause
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pause) | Out-Null
    if (-not $alreadyPaused) { Set-Content -LiteralPath $pause -Value 'Manual stop: start.ps1 resumes recovery.' }
    try { $service.Kill() } catch {
      if (-not $alreadyPaused) { Remove-Item -LiteralPath $pause -ErrorAction SilentlyContinue }
      throw
    }
    if (-not $service.WaitForExit(3000)) { throw 'Stop requested but exit was not verified. Recovery remains paused; inspect before retrying.' }
    Write-Host 'Bridge stopped. Previously dispatched browser actions may have run; inspect before retrying.'
  } finally { $service.Dispose() }
} finally { $probe.Dispose() }
