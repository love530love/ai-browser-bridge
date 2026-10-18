param(
  [switch]$Once,
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [ValidateRange(2, 60)][int]$IntervalSec = 10
)
$ErrorActionPreference = 'Stop'
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$root = [IO.Path]::GetFullPath($ProjectRoot)
$state = Join-Path $root '.local'
New-Item -ItemType Directory -Force -Path $state | Out-Null
$hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant()))).Substring(0,24)
$mutex = [Threading.Mutex]::new($false, "Local\AIBridgeWatch-$hash")
$owned = $false
$lastState = ''
$failures = 0
function Report-State([string]$name) {
  $row = @{ time=[DateTimeOffset]::Now.ToString('o'); state=$name; pid=$PID; failures=$failures }
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
        try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($config.port)/status" -Headers @{Authorization="Bearer $($config.agentToken)"} -TimeoutSec 3 } catch { }
        if ($health.service -eq 'ai-browser-bridge') {
          $failures = 0
          if ($health.maintenance) { Report-State 'maintenance' }
          elseif ($health.connected) { Report-State 'connected' }
          else { Report-State 'service-healthy-extension-disconnected' }
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
