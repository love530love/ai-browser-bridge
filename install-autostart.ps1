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
  [switch]$ScheduledTask,
  # -AdoptExternal tracks a positively verified external "AI Browser Bridge
  # Watchdog" task in this manifest so uninstall-autostart.ps1 may delete it.
  # Without it, an external task is reported but never touched.
  [switch]$AdoptExternal,
  # -Force overrides ONLY the read-only heartbeat-versus-second-route preflight.
  [switch]$Force
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

function Get-ScheduledTaskActionEvidence([string]$TaskName) {
  # Read-only. Existence alone is not identity: before this project adopts an
  # external task it must prove the task action references *this* project's
  # watch-service.ps1. schtasks /query /xml is used because it carries the
  # command and arguments; a blocked query is reported, never treated as clean.
  $ErrorActionPreference = 'SilentlyContinue'
  try {
    $xml = & schtasks.exe /query /tn $TaskName /xml 2>$null
    if ($LASTEXITCODE -ne 0) {
      return [ordered]@{ registered = $false; matchesProject = $false; error = 'not_found_or_query_blocked'; actionText = '' }
    }
    $text = ($xml -join "`n")
    $normalizedRoot = ($root -replace '\\', '/').ToLowerInvariant()
    $normalizedText = ($text -replace '\\', '/').ToLowerInvariant()
    return [ordered]@{
      registered     = $true
      matchesProject = ($normalizedText.Contains('watch-service.ps1') -and $normalizedText.Contains($normalizedRoot))
      error          = $null
      actionText     = $text
    }
  } catch {
    return [ordered]@{ registered = $false; matchesProject = $false; error = $_.Exception.Message; actionText = '' }
  }
}

function Find-SecondInspectionRoutes {
  # heartbeat --watch is a resident loop. A second inspection route (the hourly
  # single-shot automation) would collide with it on the first cycle. This is a
  # read-only preflight; unreadable scopes are left unknown by omission, not
  # reported as "clean".
  $found = [System.Collections.Generic.List[object]]::new()
  $normalizedRoot = ($root -replace '\\', '/').ToLowerInvariant()
  function Test-InspectionText([string]$text) {
    if ([string]::IsNullOrEmpty($text)) { return $false }
    $normalized = ($text -replace '\\', '/').ToLowerInvariant()
    return $normalized.Contains('heartbeat') -and
      $normalized.Contains($normalizedRoot) -and
      -not $normalized.Contains('--watch')
  }
  try {
    $key = Get-Item -LiteralPath $runKey
    foreach ($name in @($key.GetValueNames())) {
      if ($name -eq $heartbeatValueName -or $name -eq $valueName) { continue }
      $value = [string]$key.GetValue($name)
      if (Test-InspectionText $value) {
        $found.Add([ordered]@{ kind = 'registry-run'; name = $name; evidence = $value }) | Out-Null
      }
    }
  } catch { }
  try {
    $startup = [Environment]::GetFolderPath('Startup')
    $shell = New-Object -ComObject WScript.Shell
    foreach ($file in @(Get-ChildItem -LiteralPath $startup -Filter '*.lnk' -ErrorAction SilentlyContinue)) {
      if ($file.FullName -eq $heartbeatLinkPath -or $file.FullName -eq $linkPath) { continue }
      try {
        $shortcut = $shell.CreateShortcut($file.FullName)
        $evidence = ([string]$shortcut.TargetPath) + ' ' + ([string]$shortcut.Arguments)
        if (Test-InspectionText $evidence) {
          $found.Add([ordered]@{ kind = 'startup-shortcut'; path = $file.FullName; evidence = $evidence }) | Out-Null
        }
      } catch { }
    }
  } catch { }
  try {
    if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
      foreach ($task in @(Get-ScheduledTask -ErrorAction SilentlyContinue)) {
        foreach ($action in @($task.Actions)) {
          $evidence = ([string]$action.Execute) + ' ' + ([string]$action.Arguments)
          if (Test-InspectionText $evidence) {
            $found.Add([ordered]@{ kind = 'scheduled-task-route'; name = $task.TaskName; path = $task.TaskPath; evidence = $evidence }) | Out-Null
          }
        }
      }
    }
  } catch { }
  return $found.ToArray()
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
    Write-Host '  处置：保持现状（继续由外部管理，uninstall 不删除），或运行 install-autostart.ps1 -AdoptExternal 将其纳入清单；收养前会核验任务动作确实指向本项目的 scripts/watch-service.ps1，核验失败则拒绝并保持外部状态。'
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

# ---- preflight (read-only, before any write): heartbeat vs second inspection ----
# Registering a resident --watch while an hourly single-shot route already exists
# makes the first cycle report clock_drift and freeze whitelist self-healing.
# Detect it before writing runtime.json / shortcuts / the manifest; -Force is the
# explicit override and still prints the conflict.
if ($Heartbeat) {
  $secondRoutes = @(Find-SecondInspectionRoutes)
  if ($secondRoutes.Count -gt 0) {
    Write-Host 'REFUSED: -Heartbeat would register a resident heartbeat --watch beside an existing inspection route.'
    foreach ($route in $secondRoutes) {
      Write-Host ('  [second-route] ' + ($route | ConvertTo-Json -Depth 6 -Compress))
    }
    Write-Host "  $heartbeatWarning"
    if (-not $Force) {
      Write-Host '  No writes were made. Remove the second route above, or re-run with -Force after confirming you accept clock_drift and frozen self-healing on the first cycle.'
      exit 3
    }
    Write-Host '  -Force supplied: continuing with both routes. Expect clock_drift on the first cycle.'
  }
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

if ($AdoptExternal) {
  # Bring an externally registered watchdog task into this manifest so a later
  # uninstall can remove it instead of leaving an orphan that relaunches the
  # supervisor. Adoption is explicit, and only a positively verified action
  # (references this project's watch-service.ps1) is accepted.
  $alreadyManaged = @($entries | Where-Object {
    [string]$_.kind -eq 'scheduled-task' -and [string]$_.name -eq $scheduledTaskName
  }).Count -gt 0
  if (-not $alreadyManaged) {
    $evidence = Get-ScheduledTaskActionEvidence $scheduledTaskName
    if (-not $evidence.registered) {
      throw "Cannot adopt ""$scheduledTaskName"": the task was not positively found (query result: $($evidence.error)). No writes were made. Verify with: schtasks /query /tn ""$scheduledTaskName"" /xml"
    }
    if (-not $evidence.matchesProject) {
      throw "Refusing to adopt ""$scheduledTaskName"": its action is not proven to reference this project's scripts/watch-service.ps1, so an uninstall could delete an unrelated task. Inspect with: schtasks /query /tn ""$scheduledTaskName"" /xml. Re-run without -AdoptExternal to leave it external, or remove it manually and re-register with -ScheduledTask."
    }
    $entries.Add([ordered]@{
      kind       = 'scheduled-task'
      name       = $scheduledTaskName
      adopted    = $true
      adoptedAt  = [DateTimeOffset]::Now.ToString('o')
      evidence   = 'schtasks /query /xml action references this project scripts/watch-service.ps1'
    }) | Out-Null
    Write-Host "[adopted] external scheduled task ""$scheduledTaskName"" is now tracked by this manifest; uninstall-autostart.ps1 will delete it by name."
  } else {
    Write-Host "[adopted] scheduled task ""$scheduledTaskName"" is already managed by -ScheduledTask; no duplicate entry."
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
Write-Host 'External watchdog task: -AdoptExternal tracks it in the manifest (verified action only) so uninstall can clean it; -Force only overrides the heartbeat/second-route preflight.'
Write-Host 'Opt-in items are tracked in the manifest; uninstall-autostart.ps1 clears them. Run install-autostart.ps1 -StatusOnly to list all registered autostart items.'
