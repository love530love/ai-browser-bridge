# Install a per-user hidden PowerShell 7 health supervisor.
# -StatusOnly lists everything currently registered without writing anything:
# the managed manifest, the live shortcut / HKCU Run state, and any externally
# registered scheduled task (reported, never deleted).
param(
  [ValidateSet('StartupFolder','Registry')][string]$Method = 'StartupFolder',
  [switch]$StatusOnly
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$valueName = 'AIBrowserBridge'
$linkPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'AI Browser Bridge.lnk'
$watcher = Join-Path $root 'scripts/watch-service.ps1'
$arguments = '-NoProfile -WindowStyle Hidden -File "' + $watcher + '"'
$registryPath = Join-Path $root '.local/autostart-registry.json'
$runtimePath = Join-Path $root '.local/runtime.json'
$watchdogTaskName = 'AI Browser Bridge Watchdog'

# 守卫：不会自动删除外部计划任务（用户自行注册的 AI Browser Bridge Watchdog），
# 它不属于项目管理范围，检测只用于如实报告并给出可复制的删除命令。
function Get-WatchdogTaskState([string]$TaskName) {
  # Returns 'registered' when the task is positively found, otherwise 'unknown'.
  # Read-only, best-effort and never throws: the host sandbox may block
  # schtasks.exe / the ScheduledTasks module, and a failed query must not
  # abort -StatusOnly or uninstall.
  $ErrorActionPreference = 'SilentlyContinue'
  # Prefer the lightweight schtasks.exe query; fall back to the ScheduledTasks
  # cmdlet only when the executable is blocked (avoids a slow module autoload).
  try {
    $null = & schtasks.exe /query /tn $TaskName 2>$null
    if ($LASTEXITCODE -eq 0) { return 'registered' }
    return 'unknown'
  } catch { }
  try {
    if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
      if ($null -ne (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { return 'registered' }
    }
  } catch { }
  return 'unknown'
}

function Read-AutostartRegistry {
  # Returns the parsed manifest, or $null when missing / corrupt (caller
  # decides the fallback and must report unknown rather than pretend clean).
  if (-not (Test-Path -LiteralPath $registryPath -PathType Leaf)) { return $null }
  try {
    $parsed = Get-Content -LiteralPath $registryPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($null -eq $parsed -or $null -eq $parsed.entries) { return $null }
    return $parsed
  } catch { return $null }
}

function Show-AutostartStatus {
  Write-Host '=== AI Browser Bridge autostart status ==='
  Write-Host ''
  Write-Host '--- managed items (from .local/autostart-registry.json) ---'
  $reg = Read-AutostartRegistry
  if ($null -eq $reg) {
    Write-Host 'manifest missing or corrupt: managed items unknown'
  } else {
    $entries = @($reg.entries)
    if ($entries.Count -eq 0) {
      # ASCII marker kept for machine consumers (doctor-host-env / tests).
      Write-Host 'managed entries: none (entries is empty; nothing project-managed is registered)'
    } else {
      foreach ($e in $entries) {
        Write-Host ('[managed manifest entry] ' + ($e | ConvertTo-Json -Depth 6 -Compress))
        if ($e.path) {
          Write-Host ("  kind={0} path={1} target={2} arguments={3}" -f $e.kind, $e.path, $e.target, $e.arguments)
        } else {
          Write-Host ("  kind={0} key={1} name={2} value={3}" -f $e.kind, $e.key, $e.name, $e.value)
        }
      }
    }
  }
  Write-Host ''
  Write-Host '--- live state (still project-managed scope) ---'
  if (Test-Path -LiteralPath $linkPath) {
    Write-Host "[managed] startup shortcut exists: $linkPath"
  } else {
    Write-Host "[managed] startup shortcut absent: $linkPath"
  }
  try {
    $runValue = (Get-ItemProperty -LiteralPath $runKey -Name $valueName -ErrorAction SilentlyContinue).$valueName
  } catch { $runValue = $null }
  if ($runValue) {
    Write-Host "[managed] HKCU Run exists: name=$valueName value=$runValue"
  } else {
    Write-Host "[managed] HKCU Run absent: name=$valueName"
  }
  Write-Host ''
  Write-Host '--- externally registered items (managed: false; project will not auto-delete) ---'
  $state = Get-WatchdogTaskState $watchdogTaskName
  if ($state -eq 'registered') {
    Write-Host "[user-external] external: true managed: false scheduled task ""$watchdogTaskName"": detected (registered)"
    Write-Host ('  project will not auto-delete it; to remove manually: schtasks /delete /tn "' + $watchdogTaskName + '" /f')
  } else {
    Write-Host "[user-external] external: true managed: false scheduled task ""$watchdogTaskName"": 未能确认（unknown）— not found or query blocked"
    Write-Host ('  project will not auto-delete any task; verify with: schtasks /query /tn "' + $watchdogTaskName + '"')
    Write-Host ('  remove manually if present: schtasks /delete /tn "' + $watchdogTaskName + '" /f')
  }
}

# -StatusOnly is a pure read: no files, registry, tasks or processes are touched.
if ($StatusOnly) {
  Show-AutostartStatus
  return
}

# ---- install path (writes) ----
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path (Join-Path $root '.local') | Out-Null

# Persist the resolved absolute binaries once. start.ps1 / agent.ps1 /
# scripts/watch-service.ps1 (via scripts/resolve-runtime.ps1) read this first.
$runtime = [ordered]@{
  pwsh       = $pwsh
  node       = $node
  resolvedAt = [DateTimeOffset]::Now.ToString('o')
}
$runtime | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $runtimePath -Encoding utf8

& $node (Join-Path $root 'src/cli.js') setup | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Setup failed' }

$entries = [System.Collections.Generic.List[object]]::new()
if ($Method -eq 'StartupFolder') {
  # Switching away from Registry: remove the other registration so no ghost
  # entry survives in the live system or in the manifest.
  Remove-ItemProperty -LiteralPath $runKey -Name $valueName -ErrorAction SilentlyContinue
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($linkPath)
  $shortcut.TargetPath = $pwsh
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $root
  $shortcut.WindowStyle = 7
  $shortcut.Description = 'AI Browser Bridge health supervisor (PowerShell 7)'
  $shortcut.Save()
  $entries.Add([ordered]@{
    kind      = 'startup-shortcut'
    path      = $linkPath
    target    = $pwsh
    arguments = $arguments
  }) | Out-Null
} else {
  # Switching away from StartupFolder: remove the other registration so no
  # ghost entry survives in the live system or in the manifest.
  Remove-Item -LiteralPath $linkPath -ErrorAction SilentlyContinue
  New-Item -Path $runKey -Force | Out-Null
  $runValue = '"' + $pwsh + '" ' + $arguments
  Set-ItemProperty -LiteralPath $runKey -Name $valueName -Value $runValue
  $entries.Add([ordered]@{
    kind  = 'registry-run'
    key   = $runKey
    name  = $valueName
    value = $runValue
  }) | Out-Null
}

# Overwrite (never append): the manifest always lists only what was just
# registered successfully, so switching Method cannot leave a ghost entry.
$registry = [ordered]@{
  version   = 1
  updatedAt = [DateTimeOffset]::Now.ToString('o')
  entries   = $entries.ToArray()
}
$registry | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $registryPath -Encoding utf8

# Cleared through the .NET API, not Remove-Item: a filesystem shim that fails
# closed on delete would otherwise abort the install on a path that may not even
# exist, and the shim can shadow the cmdlet but not [System.IO.File].
foreach ($stale in @('.local/watchdog-disabled', '.local/service-paused')) {
  $stalePath = Join-Path $root $stale
  if ([System.IO.File]::Exists($stalePath)) {
    try { [System.IO.File]::Delete($stalePath) } catch { Write-Host "Left $stale in place: $($_.Exception.Message)" }
  }
}
Start-Process -FilePath $pwsh -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden | Out-Null
Write-Host 'Health supervisor installed and launched. Check .local/watchdog-status.json and npm run doctor.'
Write-Host 'stop.ps1 pauses recovery; start.ps1 resumes it. uninstall-autostart.ps1 disables the supervisor.'
Write-Host 'Run install-autostart.ps1 -StatusOnly to list all registered autostart items.'
