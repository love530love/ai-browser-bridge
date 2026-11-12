# Install a per-user hidden PowerShell 7 health supervisor.
# -StatusOnly lists everything currently registered without writing anything:
# the managed manifest, the live shortcut / HKCU Run state, and any externally
# registered scheduled task (reported, never deleted).
param(
  [ValidateSet('StartupFolder','Registry')][string]$Method = 'StartupFolder',
  [switch]$StatusOnly,
  # Both are opt-in and OFF by default: the classic install (startup shortcut /
  # HKCU Run running watch-service.ps1) is unchanged when neither is supplied.
  # -Heartbeat makes heartbeat --watch resident; -ScheduledTask registers a
  # logon-triggered watchdog task. See the warning below before enabling.
  [switch]$Heartbeat,
  [switch]$ScheduledTask
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
$scheduledTaskName = $watchdogTaskName
$heartbeatValueName = 'AIBrowserBridgeHeartbeat'
$heartbeatLinkPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'AI Browser Bridge Heartbeat.lnk'
$heartbeatIntervalMs = 60000
# 实测：heartbeat --watch 与每小时单次巡检 automation 混用时，首轮必报
# clock_drift 并冻结自愈（--watch 强制固定周期，hourly 单次巡检间隔远大于此）。
# 两者二选一，绝不要同时启用。这句话同时写进控制台输出与清单条目。
$heartbeatWarning = 'heartbeat --watch 与每小时单次巡检 automation 二选一，不要同时启用：实测 --watch 与 hourly 混用首轮必报 clock_drift 并冻结自愈'
$taskXmlPath = Join-Path $root '.local/watchdog-scheduled-task.xml'

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

function ConvertTo-XmlText([string]$text) {
  # Escape paths / arguments before embedding them in the task definition XML.
  # Plain string replaces (no assembly dependency); '&' must be escaped first.
  if ([string]::IsNullOrEmpty($text)) { return '' }
  return $text.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&apos;')
}

function New-WatchdogTaskXml([string]$CommandPath, [string]$ArgumentsText, [string]$WorkingDir) {
  # schtasks.exe has no CLI flag for ExecutionTimeLimit or RestartOnFailure,
  # so the managed task is created from /xml. LogonTrigger == /sc ONLOGON.
  $cmd = ConvertTo-XmlText $CommandPath
  $arg = ConvertTo-XmlText $ArgumentsText
  $wd  = ConvertTo-XmlText $WorkingDir
  return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$cmd</Command>
      <Arguments>$arg</Arguments>
      <WorkingDirectory>$wd</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
}

function Add-ManagedScheduledTask {
  # Best-effort, NEVER throws: a sandbox / insufficient permission must not
  # abort the whole install. Returns $true only on positive evidence (exit 0),
  # otherwise reports 'unknown' and prints a copyable create command.
  $copyCmd = 'schtasks.exe /create /xml "' + $taskXmlPath + '" /tn "' + $scheduledTaskName + '" /f'
  try {
    $xml = New-WatchdogTaskXml -CommandPath $pwsh -ArgumentsText $arguments -WorkingDir $root
    # UTF-16LE with BOM is what schtasks.exe /xml expects.
    [System.IO.File]::WriteAllText($taskXmlPath, $xml, [System.Text.Encoding]::Unicode)
    $null = & schtasks.exe /create /xml $taskXmlPath /tn $scheduledTaskName /f 2>$null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "[managed] scheduled task ""$scheduledTaskName"" registered (logon trigger, ExecutionTimeLimit PT0S, restart on failure 3 times)."
      return $true
    }
    Write-Host "[scheduled-task] registration result: unknown (schtasks.exe exit $LASTEXITCODE; sandbox / permission may have blocked it)."
    Write-Host "  copyable create command: $copyCmd"
    return $false
  } catch {
    Write-Host "[scheduled-task] registration result: unknown ($($_.Exception.Message))."
    Write-Host "  copyable create command: $copyCmd"
    return $false
  }
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
  $managedScheduledTask = $false
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
        $k = [string]$e.kind
        if ($k -eq 'scheduled-task') { $managedScheduledTask = $true }
        if ($k -eq 'heartbeat-watch') {
          Write-Host ("  kind=heartbeat-watch command={0} intervalMs={1} [managed]" -f $e.command, $e.intervalMs)
          if ($e.warning) { Write-Host ("  warning: {0}" -f $e.warning) }
          else { Write-Host ("  warning: {0}" -f $heartbeatWarning) }
        } elseif ($k -eq 'scheduled-task') {
          Write-Host ("  kind=scheduled-task name={0} [managed]" -f $e.name)
          Write-Host "  managed: true — registered by -ScheduledTask; uninstall-autostart.ps1 clears it from this manifest"
        } elseif ($e.path) {
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
    if ($managedScheduledTask) {
      Write-Host '  注意：同名任务已在上方 managed 清单登记（由 -ScheduledTask 注册），此处检测到的很可能就是该项目管理项，uninstall 会按清单清理。'
    }
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

# ---- optional registrations (default OFF; classic install above unchanged) ----
# Re-running without a switch does NOT delete a previously opt-in item: only
# uninstall-autostart.ps1 clears items tracked in the manifest. This keeps the
# project conservative about deleting anything it cannot prove it owns.
if ($Heartbeat) {
  # heartbeat --watch is a resident loop and must NOT be paired with the hourly
  # single-shot automation: the first cycle would report clock_drift and freeze
  # whitelist self-healing. Echo the warning AND store it in the manifest entry
  # so -StatusOnly / the registry carry the exact same contract.
  $heartbeatArguments = '"' + (Join-Path $root 'src/cli.js') + '" heartbeat --watch --interval-ms ' + $heartbeatIntervalMs
  $heartbeatCommand = '"' + $node + '" ' + $heartbeatArguments
  Write-Host "WARNING: $heartbeatWarning"
  if ($Method -eq 'StartupFolder') {
    $hbShortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($heartbeatLinkPath)
    $hbShortcut.TargetPath = $node
    $hbShortcut.Arguments = $heartbeatArguments
    $hbShortcut.WorkingDirectory = $root
    $hbShortcut.WindowStyle = 7
    $hbShortcut.Description = 'AI Browser Bridge heartbeat watchdog (opt-in, --watch)'
    $hbShortcut.Save()
    $entries.Add([ordered]@{
      kind       = 'heartbeat-watch'
      command    = $heartbeatCommand
      intervalMs = $heartbeatIntervalMs
      path       = $heartbeatLinkPath
      target     = $node
      arguments  = $heartbeatArguments
      warning    = $heartbeatWarning
    }) | Out-Null
  } else {
    $hbRunValue = $heartbeatCommand
    Set-ItemProperty -LiteralPath $runKey -Name $heartbeatValueName -Value $hbRunValue
    $entries.Add([ordered]@{
      kind       = 'heartbeat-watch'
      command    = $heartbeatCommand
      intervalMs = $heartbeatIntervalMs
      key        = $runKey
      name       = $heartbeatValueName
      value      = $hbRunValue
      warning    = $heartbeatWarning
    }) | Out-Null
  }
}

if ($ScheduledTask) {
  # Only add a managed entry when creation is positively confirmed (exit 0).
  # On unknown, Add-ManagedScheduledTask reports + prints a copyable command and
  # the install continues without claiming a task it cannot prove it registered.
  if (Add-ManagedScheduledTask) {
    $entries.Add([ordered]@{
      kind = 'scheduled-task'
      name = $scheduledTaskName
    }) | Out-Null
  }
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
Write-Host 'Optional (off by default): -Heartbeat (heartbeat --watch resident) and -ScheduledTask (logon-triggered watchdog task).'
Write-Host "If -Heartbeat is used: $heartbeatWarning"
Write-Host 'Opt-in items are tracked in the manifest; uninstall-autostart.ps1 clears them. Run install-autostart.ps1 -StatusOnly to list all registered autostart items.'
