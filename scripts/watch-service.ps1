param(
  [switch]$Once,
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [ValidateRange(2, 60)][int]$IntervalSec = 10
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-runtime.ps1')
$root = [IO.Path]::GetFullPath($ProjectRoot)
$pwsh = Resolve-BridgeBinary -Root $root -Kind pwsh
$state = Join-Path $root '.local'
New-Item -ItemType Directory -Force -Path $state | Out-Null
$hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant()))).Substring(0,24)
$mutex = [Threading.Mutex]::new($false, "Local\AIBridgeWatch-$hash")
$owned = $false
$lastState = ''
$failures = 0

# ---- P0-2: read-only stale-source detection (observable, never a restart) ----
# The watchdog's contract is liveness, not build identity. Comparing the running
# buildId with the on-disk source tree here is deliberately READ ONLY: it reports
# a 'build-stale-restart-needed' state and leaves evidence, but the ordered,
# idle-gated restart belongs to heartbeat's whitelist (upgrade-check / -Heartbeat).
# It NEVER kills a process, NEVER writes a pause marker and NEVER invokes the
# stop script: the watchdog cannot see in-flight commands, and a developer
# editing src/*.js would otherwise be restarted repeatedly, breaking sessions.
$script:diskBuildCache = $null      # last known 64-hex disk build id (or $null)
$script:diskBuildUnknown = $false   # last node probe failed / timed out
$script:lastRunningBuildId = $null  # buildId reported by /status on the last cycle
$script:buildProbeCounter = 0       # loop counter behind the lightweight cache

function Get-DiskBuildIdentity {
  param([string]$RunningBuildId)
  # Recompute at most every 6 cycles, or immediately when the running buildId
  # changes, or while we have no usable value. The periodic recompute is
  # essential: disk code can change (git pull) while the running buildId stays
  # constant, so caching on runningBuildId alone would never notice the pull.
  $script:buildProbeCounter++
  $needsProbe = ($null -eq $script:diskBuildCache) -and (-not $script:diskBuildUnknown)
  if (-not $needsProbe) {
    if ($RunningBuildId -ne $script:lastRunningBuildId) { $needsProbe = $true }
    if ($script:buildProbeCounter % 6 -eq 0) { $needsProbe = $true }
  }
  $script:lastRunningBuildId = $RunningBuildId
  if (-not $needsProbe) {
    if ($script:diskBuildUnknown) { return $null }  # keep reporting 'unknown'
    return $script:diskBuildCache
  }

  # Any failure below is 'unknown', NEVER a verdict that the service is broken.
  try {
    $node = Resolve-BridgeBinary -Root $root -Kind node
    $jsExpr = 'import(''./src/build-identity.js'').then(m=>console.log(m.computeBuildIdentity(process.cwd())))'
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $node
    $psi.Arguments = '-e "' + $jsExpr + '"'
    $psi.WorkingDirectory = $root
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $probe = [System.Diagnostics.Process]::Start($psi)
    if (-not $probe.WaitForExit(8000)) {
      try { $probe.Kill($true) } catch { }
      try { $probe.Dispose() } catch { }
      $script:diskBuildUnknown = $true
      return $null
    }
    $out = ($probe.StandardOutput.ReadToEnd() ?? '').Trim()
    $null = $probe.StandardError.ReadToEnd()
    $exitCode = $probe.ExitCode
    try { $probe.Dispose() } catch { }
    if ($exitCode -ne 0 -or -not ($out -match '^[a-f0-9]{64}$')) {
      $script:diskBuildUnknown = $true
      return $null
    }
    $script:diskBuildCache = $out
    $script:diskBuildUnknown = $false
    return $out
  } catch {
    $script:diskBuildUnknown = $true
    return $null
  }
}

function Report-State([string]$name, [hashtable]$evidence = @{}) {
  $row = @{ time=[DateTimeOffset]::Now.ToString('o'); state=$name; pid=$PID; failures=$failures }
  foreach ($k in $evidence.Keys) { if (-not $row.ContainsKey($k)) { $row[$k] = $evidence[$k] } }
  $row | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $state 'watchdog-status.json') -Encoding utf8
  if ($name -ne $script:lastState) {
    $log = Join-Path $state 'watchdog.jsonl'
    if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 1MB) {
      Move-Item -LiteralPath $log -Destination (Join-Path $state 'watchdog.previous.jsonl') -Force
    }
    $row | ConvertTo-Json -Compress | Add-Content -LiteralPath $log -Encoding utf8
    $script:lastState = $name
  }
}
try {
  try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { exit 0 }
  do {
    try {
      if (Test-Path -LiteralPath (Join-Path $state 'watchdog-disabled')) { Report-State 'disabled'; break }
      if (Test-Path -LiteralPath (Join-Path $state 'service-paused')) { Report-State 'paused' }
      else {
        $config = Get-Content -LiteralPath (Join-Path $state 'config.json') -Raw | ConvertFrom-Json
        $health = $null
        # Loopback only. -NoProxy keeps an injected HTTP_PROXY from swallowing
        # the health probe and making a running service look dead.
        try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($config.port)/status" -Headers @{Authorization="Bearer $($config.agentToken)"} -TimeoutSec 3 -NoProxy } catch { }
        if ($health.service -eq 'ai-browser-bridge') {
          $failures = 0
          # Read-only stale check. NEVER restart / kill / pause here; the ordered,
          # idle-gated restart is heartbeat's whitelist action (upgrade-check /
          # -Heartbeat). This branch only reports and leaves evidence.
          $runningBuildId = [string]$health.buildId
          $diskBuild = Get-DiskBuildIdentity -RunningBuildId $runningBuildId
          $staleVerdict = 'unknown'
          if ($null -ne $diskBuild -and $runningBuildId) {
            if ($runningBuildId -ne $diskBuild) { $staleVerdict = 'stale' }
            else { $staleVerdict = 'match' }
          }
          $staleEvidence = @{
            buildStaleCheck = $staleVerdict
            runningBuildId  = $runningBuildId
            diskBuildId     = if ($null -eq $diskBuild) { 'unknown' } else { $diskBuild }
          }
          if ($staleVerdict -eq 'stale') {
            # New observable state. Only Report-State is called here: no kill,
            # no pause marker, no stop script, no restart. Read-only evidence.
            Report-State 'build-stale-restart-needed' ($staleEvidence + @{
              action = 'report-only'
              note   = 'running source tree differs from disk (git pull); arrange an idle restart via upgrade-check / -Heartbeat; watchdog does NOT restart'
            })
          } elseif ($staleVerdict -eq 'unknown') {
            # node probe failed / timed out: report the check as unknown but keep
            # the NORMAL liveness state, never judge the service as failed.
            if ($health.maintenance) { Report-State 'maintenance' $staleEvidence }
            elseif ($health.connected) { Report-State 'connected' $staleEvidence }
            else { Report-State 'service-healthy-extension-disconnected' $staleEvidence }
          } else {
            if ($health.maintenance) { Report-State 'maintenance' }
            elseif ($health.connected) { Report-State 'connected' }
            else { Report-State 'service-healthy-extension-disconnected' }
          }
        } else {
          # Do not kill an occupied port: it may be another app or an uncertain write.
          $tcp = [Net.Sockets.TcpClient]::new()
          try { $listening = $tcp.ConnectAsync('127.0.0.1', [int]$config.port).Wait(1000) -and $tcp.Connected } catch { $listening = $false } finally { $tcp.Dispose() }
          if ($listening) { Report-State 'port-occupied-or-service-unresponsive' }
          else {
            Report-State 'starting-service'
            $child = Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile','-File',('"' + (Join-Path $root 'start.ps1') + '"')) -WorkingDirectory $root -WindowStyle Hidden -PassThru
            if (-not $child.WaitForExit(25000)) { $child.Kill($true); throw 'Startup timed out' }
            if ($child.ExitCode -ne 0) { throw 'Startup failed' }
            Report-State 'startup-completed'
          }
        }
      }
    } catch { $failures++; Report-State 'recovery-failed-check-server-logs' }
    if (-not $Once) { Start-Sleep -Seconds ([Math]::Min(60, $IntervalSec * [Math]::Pow(2, [Math]::Min(3,$failures)))) }
  } while (-not $Once)
} finally { if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
