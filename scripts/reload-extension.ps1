param(
  [string]$ExtensionId = 'mmopbppoabmhliflinadkgnedjpmbgig',
  [int]$ChromeProcessId = 0,
  [long]$ChromeWindowHandle = 0,
  [switch]$ListWindows,
  [switch]$AsJson,
  [switch]$BestEffort,
  [ValidateRange(1, 120)][int]$VerifyTimeoutSec = 15
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeWindow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int maxCount);
  public static string WindowTitle(IntPtr hWnd) {
    var text = new System.Text.StringBuilder(512);
    GetWindowText(hWnd, text, text.Capacity);
    return text.ToString();
  }
  public static IntPtr[] VisibleWindowsForProcess(int targetProcessId) {
    var handles = new System.Collections.Generic.List<IntPtr>();
    EnumWindows((hWnd, lParam) => {
      uint processId;
      GetWindowThreadProcessId(hWnd, out processId);
      if ((targetProcessId == 0 || processId == (uint)targetProcessId) && IsWindowVisible(hWnd)) handles.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    return handles.ToArray();
  }
}
'@
if ($ListWindows) {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $windows = @()
  foreach ($process in (Get-Process chrome -ErrorAction SilentlyContinue)) {
    foreach ($handle in [NativeWindow]::VisibleWindowsForProcess($process.Id)) {
      $windows += [pscustomobject]@{ ProcessId=$process.Id; WindowHandle=$handle.ToInt64(); Title=[NativeWindow]::WindowTitle($handle) }
    }
  }
  if ($AsJson) { ConvertTo-Json -InputObject @($windows) -Compress }
  else { $windows }
  exit 0
}
$fixedExtensionId = 'mmopbppoabmhliflinadkgnedjpmbgig'
if ($ExtensionId -ne $fixedExtensionId) {
  $message = 'This script only operates on the fixed AI Browser Bridge extension; no UI action was taken.'
  if ($BestEffort) { Write-Warning $message; exit 2 }
  throw $message
}
$config = Get-Content -LiteralPath (Join-Path $projectRoot '.local/config.json') -Raw | ConvertFrom-Json
$expectedVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'extension/manifest.json') -Raw | ConvertFrom-Json).version
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$chromeWindows = @()
if ($ChromeProcessId -gt 0) {
  $targetProcess = Get-Process -Id $ChromeProcessId -ErrorAction SilentlyContinue
  if (-not $targetProcess -or $targetProcess.ProcessName -ne 'chrome' -or
      [string]::IsNullOrWhiteSpace($targetProcess.Path) -or [System.IO.Path]::GetFileName($targetProcess.Path) -ine 'chrome.exe') {
    $message = "Process ID $ChromeProcessId is not a verified Chrome process; no UI action was taken."
    if ($BestEffort) { Write-Warning $message; exit 2 }
    throw $message
  }
  $handles = [NativeWindow]::VisibleWindowsForProcess($ChromeProcessId)
  foreach ($handle in $handles) { $chromeWindows += [pscustomobject]@{ ProcessId=$ChromeProcessId; Handle=$handle } }
} else {
  foreach ($process in (Get-Process chrome -ErrorAction SilentlyContinue)) {
    foreach ($handle in [NativeWindow]::VisibleWindowsForProcess($process.Id)) {
      $chromeWindows += [pscustomobject]@{ ProcessId=$process.Id; Handle=$handle }
    }
  }
}
if ($ChromeWindowHandle -gt 0) {
  $chromeWindows = @($chromeWindows | Where-Object { $_.Handle.ToInt64() -eq $ChromeWindowHandle })
} elseif ($chromeWindows.Count -gt 1) {
  $message = 'Multiple visible Chrome windows found. Specify -ChromeWindowHandle and -ChromeProcessId; no UI action was taken.'
  if ($BestEffort) { Write-Warning $message; exit 2 }
  throw $message
}
$chromeWindow = $chromeWindows | Select-Object -First 1
if (-not $chromeWindow) {
  $message = if ($ChromeWindowHandle -gt 0) { "No visible Chrome window matched handle $ChromeWindowHandle; no UI action was taken." } elseif ($ChromeProcessId -gt 0) { "No visible Chrome window for process ID $ChromeProcessId; no UI action was taken." } else { 'No visible Chrome window; extension reload was not attempted.' }
  if ($BestEffort) { Write-Warning $message; exit 2 }
  throw $message
}
$targetUrl = "chrome://extensions/?id=$ExtensionId"
$focused = [NativeWindow]::SetForegroundWindow($chromeWindow.Handle)
if (-not $focused -or [NativeWindow]::GetForegroundWindow() -ne $chromeWindow.Handle) {
  $message = 'Could not verify the selected Chrome window is foreground; no keyboard input was sent.'
  if ($BestEffort) { Write-Warning $message; exit 2 }
  throw $message
}
$shell = New-Object -ComObject WScript.Shell
$shell.SendKeys('^l'); Start-Sleep -Milliseconds 150
$shell.SendKeys($targetUrl); Start-Sleep -Milliseconds 150
$shell.SendKeys('%{ENTER}')
$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$exactCandidates = @()
$controlDeadline = (Get-Date).AddSeconds(12)
do {
  $exactCandidates = @()
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($chromeWindow.Handle)
    $buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    foreach ($button in $buttons) {
      if (@('Reload','重新加载','Reload extension') -notcontains [string]$button.Current.Name) { continue }
      $node = $button
      $context = ''
      for ($i = 0; $i -lt 8 -and $node; $i++) {
        $context += ' ' + [string]$node.Current.Name + ' ' + [string]$node.Current.AutomationId
        $node = $walker.GetParent($node)
      }
      if ($context -match [regex]::Escape($ExtensionId)) { $exactCandidates += $button }
    }
    # Chrome can flatten extension card ancestors in its accessibility tree.
    # Bind the exact details URL and visible ID before accepting its unique
    # developer Reload control; never fall back to the browser toolbar Reload.
    if ($exactCandidates.Count -eq 0) {
      $editCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Edit)
      $comboCondition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::ComboBox)
      $addressControls = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCondition)) + @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $comboCondition))
      $urlMatched = $false
      foreach ($edit in $addressControls) {
        try {
          $value = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
          if (-not $edit.Current.IsOffscreen -and ($value -eq $targetUrl -or $value -eq "chrome://extensions?id=$ExtensionId")) { $urlMatched = $true }
        } catch { }
      }
      if ($urlMatched) {
        $idCondition = [System.Windows.Automation.PropertyCondition]::new(
          [System.Windows.Automation.AutomationElement]::NameProperty, $ExtensionId)
        $idNodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $idCondition)
        $visibleIds = @($idNodes | Where-Object { -not $_.Current.IsOffscreen })
        if ($visibleIds.Count -eq 1) {
          $exactCandidates = @($buttons | Where-Object {
            $_.Current.AutomationId -eq 'dev-reload-button' -and -not $_.Current.IsOffscreen -and $_.Current.IsEnabled
          })
        }
      }
    }
  } catch { $exactCandidates = @() }
  if ($exactCandidates.Count -eq 0) { Start-Sleep -Milliseconds 250 }
} while ($exactCandidates.Count -eq 0 -and (Get-Date) -lt $controlDeadline)
if ($exactCandidates.Count -eq 1) { $candidate = $exactCandidates[0] }
elseif ($exactCandidates.Count -gt 1) {
  $message = "Multiple Reload controls matched extension ID $ExtensionId; no action was taken."
  if ($BestEffort) { Write-Warning $message; exit 2 }
  throw $message
} else {
  $message = "Reload button for extension $ExtensionId was not uniquely identified. No action was taken."
  if ($BestEffort) { Write-Warning $message; exit 2 }
  throw $message
}
# Capture the current authenticated extension session. A matching version alone
# after Invoke is not evidence that this Reload caused a reconnect.
$baselineSessionId = $null
try {
  $beforeStatus = Invoke-RestMethod -Uri "http://127.0.0.1:$($config.port)/status" -Headers @{ Authorization = "Bearer $($config.agentToken)" } -TimeoutSec 3
  if ($beforeStatus.connected -eq $true) { $baselineSessionId = [string]$beforeStatus.extensionSessionId }
} catch {
  $message = 'Bridge status could not be read before Reload; no UI action was taken.'
  if ($BestEffort) { Write-Warning $message; exit 2 }
  throw $message
}
# Exit contract for callers: 2 means no Reload was invoked; 3 means Invoke may
# have dispatched, so callers must observe state and must not automatically retry.
try {
  $candidate.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
} catch {
  Write-Warning "Reload invocation outcome is uncertain: $($_.Exception.Message)"
  if ($BestEffort) { exit 3 }
  throw
}
Write-Host "Requested Reload for extension $ExtensionId."

# Reload is asynchronous. Give the service a chance to reconnect and report a
# useful result to upgrade.ps1; never click a second time automatically.
$deadline = (Get-Date).AddSeconds($VerifyTimeoutSec)
do {
  Start-Sleep -Milliseconds 500
  try {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$($config.port)/status" -Headers @{ Authorization = "Bearer $($config.agentToken)" } -TimeoutSec 2
    $sessionId = [string]$status.extensionSessionId
    $newSessionObserved = -not [string]::IsNullOrWhiteSpace($sessionId) -and $sessionId -ne $baselineSessionId
    if ($status.connected -eq $true -and $status.extensionVersion -eq $expectedVersion -and $newSessionObserved) {
      Write-Host "A new extension connection is healthy (version $($status.extensionVersion))."
      exit 0
    }
  } catch { }
} while ((Get-Date) -lt $deadline)
if ($BestEffort) { Write-Warning 'Reload was clicked, but the target version was not verified; do not retry without observing state.'; exit 3 }
throw 'Reload was clicked, but the extension did not report connected before timeout.'
