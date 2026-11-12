# Remove the auto-start registration installed by install-autostart.ps1.
# Cleans up from .local/autostart-registry.json (one line per entry: removed /
# not-found), keeps the manifest as an empty-entries evidence file, reports but
# never deletes externally registered scheduled tasks, and is idempotent.
#
# 守卫：不会自动删除外部计划任务（用户自行注册的 AI Browser Bridge Watchdog）。
# 仅当清单里存在由本项目 -ScheduledTask 注册的 scheduled-task 条目时才按名字删除；
# -Heartbeat 注册的 heartbeat-watch 条目（快捷方式 / HKCU Run）同样按清单清理。
# 查不到或被沙箱拦时如实报 unknown 并给出可复制命令，绝不因为查不到就声称
# 「自启已全部清除」。
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$registryPath = Join-Path $root '.local/autostart-registry.json'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$valueName = 'AIBrowserBridge'
$linkPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'AI Browser Bridge.lnk'
$watchdogTaskName = 'AI Browser Bridge Watchdog'

function Get-WatchdogTaskState([string]$TaskName) {
  # Returns 'registered' when the task is positively found, otherwise 'unknown'.
  # Read-only, best-effort and never throws: the host sandbox may block
  # schtasks.exe / the ScheduledTasks module, and a failed query must not
  # abort the uninstall.
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
  # Returns the parsed manifest, or $null when missing / corrupt. The caller
  # then falls back to scanning the two known methods and reports unknown.
  if (-not (Test-Path -LiteralPath $registryPath -PathType Leaf)) { return $null }
  try {
    $parsed = Get-Content -LiteralPath $registryPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($null -eq $parsed -or $null -eq $parsed.entries) { return $null }
    return $parsed
  } catch { return $null }
}

function Remove-AutostartEntry($e) {
  # Cleans one managed entry and returns a "removed / not-found" line that also
  # carries the concrete path. A scheduled task is deleted ONLY when it is an
  # entry in this manifest (i.e. registered by -ScheduledTask); an externally
  # registered task with the same name is never passed here and never deleted.
  $kind = [string]$e.kind
  if ($kind -eq 'startup-shortcut') {
    $p = if ($e.path) { [string]$e.path } else { $script:linkPath }
    try {
      if (Test-Path -LiteralPath $p) {
        Remove-Item -LiteralPath $p -Force -ErrorAction Stop
        return "已移除 startup shortcut: $p"
      }
      return "未找到 startup shortcut: $p"
    } catch { return "未找到/未能确认 startup shortcut: $p（$($_.Exception.Message)）" }
  }
  if ($kind -eq 'registry-run') {
    $k = if ($e.key) { [string]$e.key } else { $script:runKey }
    $n = if ($e.name) { [string]$e.name } else { $script:valueName }
    try {
      if (Get-ItemProperty -LiteralPath $k -Name $n -ErrorAction SilentlyContinue) {
        Remove-ItemProperty -LiteralPath $k -Name $n -ErrorAction Stop
        return "已移除 registry entry: $k\$n"
      }
      return "未找到 registry entry: $k\$n"
    } catch { return "未找到/未能确认 registry entry: $k\$n（$($_.Exception.Message)）" }
  }
  # ---- opt-in entries added by install-autostart.ps1 (default OFF) ----
  if ($kind -eq 'heartbeat-watch') {
    # Remove the shortcut OR the HKCU Run value this project registered for the
    # heartbeat --watch resident loop. Never touch anything else.
    if ($e.path) {
      $p = [string]$e.path
      try {
        if (Test-Path -LiteralPath $p) {
          Remove-Item -LiteralPath $p -Force -ErrorAction Stop
          return "已移除 heartbeat-watch startup shortcut: $p"
        }
        return "未找到 heartbeat-watch startup shortcut: $p"
      } catch { return "未找到/未能确认 heartbeat-watch startup shortcut: $p（$($_.Exception.Message)）" }
    }
    if ($e.key -and $e.name) {
      $k = [string]$e.key
      $n = [string]$e.name
      try {
        if (Get-ItemProperty -LiteralPath $k -Name $n -ErrorAction SilentlyContinue) {
          Remove-ItemProperty -LiteralPath $k -Name $n -ErrorAction Stop
          return "已移除 heartbeat-watch registry entry: $k\$n"
        }
        return "未找到 heartbeat-watch registry entry: $k\$n"
      } catch { return "未找到/未能确认 heartbeat-watch registry entry: $k\$n（$($_.Exception.Message)）" }
    }
    return "跳过（缺少 path/key/name，无法定位）清单项 kind=heartbeat-watch"
  }
  if ($kind -eq 'scheduled-task') {
    # ONLY delete the task named in this manifest entry (project-registered).
    # A user's external task with the same name is never passed here. On a
    # sandbox / permission failure, report unknown and give a copyable command;
    # never throw, so the rest of the uninstall still empties the manifest.
    $n = if ($e.name) { [string]$e.name } else { $script:watchdogTaskName }
    $delCmd = 'schtasks.exe /delete /tn "' + $n + '" /f'
    try {
      $null = & schtasks.exe /delete /tn $n /f 2>$null
      if ($LASTEXITCODE -eq 0) { return "已移除 scheduled-task: $n" }
      return "scheduled-task $n 删除结果：unknown（schtasks.exe exit $LASTEXITCODE）；可复制命令：$delCmd"
    } catch {
      return "scheduled-task $n 删除结果：unknown（$($_.Exception.Message)）；可复制命令：$delCmd"
    }
  }
  return "跳过（不自动删除）清单项 kind=$kind：外部项交由用户自行处理"
}

New-Item -ItemType Directory -Force -Path (Join-Path $root '.local') | Out-Null
# Keep the supervisor disabled marker (project convention, .NET-friendly write).
Set-Content -LiteralPath (Join-Path $root '.local/watchdog-disabled') -Value 'Autostart removed; supervisor exits on its next check.' -Encoding utf8

$lines = @()
$reg = Read-AutostartRegistry
if ($null -eq $reg) {
  # No valid manifest: report unknown (never pretend clean) and fall back to
  # scanning the two known registration methods.
  Write-Host '未找到有效的 .local/autostart-registry.json 清单（缺失或损坏）：unknown，无法保证清理完整。'
  Write-Host '回退到扫描两种已知注册方式（启动文件夹快捷方式 / HKCU Run）。'
  $fallback = @(
    [ordered]@{ kind = 'startup-shortcut'; path = $linkPath }
    [ordered]@{ kind = 'registry-run'; key = $runKey; name = $valueName }
  )
  foreach ($e in $fallback) { $lines += Remove-AutostartEntry $e }
} else {
  $entries = @($reg.entries)
  if ($entries.Count -eq 0) {
    Write-Host '清单 entries 为空：没有项目管理的自启注册项需要清理。'
  }
  foreach ($e in $entries) { $lines += Remove-AutostartEntry $e }
}

if ($lines.Count -eq 0) {
  Write-Host 'No auto-start registration was found. Nothing to remove.'
} else {
  Write-Host 'Removed / not-found (per manifest entry):'
  foreach ($item in $lines) { Write-Host ("  - {0}" -f $item) }
}

# Legacy cleanup: bridge-autostart.vbs / bridge-autostart.cmd / .local\node-path.txt
# are leftovers from an older installer; the CURRENT install-autostart.ps1 does
# NOT generate them. Only report when one actually exists, so users do not think
# the uninstall deleted something important.
foreach ($relative in @('bridge-autostart.vbs', 'bridge-autostart.cmd')) {
  $path = Join-Path $root $relative
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    Write-Host "发现并移除历史遗留启动器: $relative"
  }
}
$nodePathFile = Join-Path $root '.local\node-path.txt'
if ([System.IO.File]::Exists($nodePathFile)) {
  # .local files use the .NET delete API, not Remove-Item (safe-delete shim).
  try { [System.IO.File]::Delete($nodePathFile); Write-Host '发现并移除历史遗留 .local\node-path.txt' }
  catch { Write-Host "保留 .local\node-path.txt：$($_.Exception.Message)" }
}

# Keep the manifest file as evidence, but with an empty entries array.
$empty = [ordered]@{
  version   = 1
  updatedAt = [DateTimeOffset]::Now.ToString('o')
  entries   = @()
}
$empty | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $registryPath -Encoding utf8

# Externally registered scheduled task: detect and report, never delete.
$state = Get-WatchdogTaskState $watchdogTaskName
Write-Host ''
if ($state -eq 'registered') {
  Write-Host '检测到外部注册的计划任务 "AI Browser Bridge Watchdog"，项目不会自动删除。'
  Write-Host '卸载后该任务仍可能在登录时把守护拉起；如需移除请手动（复制）执行：'
  Write-Host ('  schtasks /delete /tn "' + $watchdogTaskName + '" /f')
} else {
  Write-Host '计划任务检测：未能确认（unknown）——本机无法查询 schtasks 或该任务不存在。'
  Write-Host '项目不会自动删除任何计划任务；如需自行确认 / 移除：'
  Write-Host ('  schtasks /query /tn "' + $watchdogTaskName + '"')
  Write-Host ('  schtasks /delete /tn "' + $watchdogTaskName + '" /f')
}

Write-Host ''
Write-Host '项目管理的登录自启注册已按清单清理；外部注册的计划任务（若有）不受本脚本管理，也不会被自动删除。'
Write-Host '注意：本脚本不宣称「自启已全部清除」——外部计划任务需按上方命令自行确认。'
Write-Host '先前启动的服务仍在运行；如需停止请用 stop.ps1。'
Write-Host '配对密钥、上传根目录与 agent 策略仍保留在 .local/，未被改动。'
