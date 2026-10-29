param(
  [string]$ExtensionId = 'mmopbppoabmhliflinadkgnedjpmbgig',
  [int]$ChromeProcessId = 0,
  [long]$ChromeWindowHandle = 0,
  [string]$ExpectedUrlPrefix = 'chrome://extensions',
  [string]$RequireUrlContains = '',
  [ValidateRange(1000, 30000)][int]$DocumentTimeoutMs = 9000,
  [ValidateRange(500, 15000)][int]$ClearAllTimeoutMs = 5000,
  [ValidateRange(500, 15000)][int]$SettleTimeoutMs = 4000
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes

function Emit($payload) {
  $payload | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

if ([string]::IsNullOrWhiteSpace($RequireUrlContains)) { $RequireUrlContains = "errors=$ExtensionId" }

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BridgeChromeWindows {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  public static string Title(IntPtr hWnd) {
    var text = new StringBuilder(512);
    GetWindowText(hWnd, text, text.Capacity);
    return text.ToString();
  }
  // A titleless top-level window owned by chrome.exe is a menu or a popup, not a
  // browser window; offering it as a target is how a caller ends up clicking
  // inside something that vanishes.
  public static IntPtr[] Visible(int processId) {
    var handles = new System.Collections.Generic.List<IntPtr>();
    EnumWindows((hWnd, lParam) => {
      uint owner;
      GetWindowThreadProcessId(hWnd, out owner);
      if ((processId == 0 || owner == (uint)processId) && IsWindowVisible(hWnd) && Title(hWnd).Length > 0) handles.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    return handles.ToArray();
  }
}
'@

# ---------------------------------------------------------------------------
# Target resolution.
#
# The old version refused to run unless exactly one Chrome window existed, and
# the caller turned that refusal into "skipped" while still reporting the reload
# as a success. Two windows is an ordinary situation, so that was a permanent
# silent failure.
#
# The window is identified instead by what it is showing. The address bar is
# browser chrome, not page content: its ValuePattern is readable even when the
# page exposes no document and even when the window is minimised, which is
# exactly the state this script has to work from.
# ---------------------------------------------------------------------------
function Get-AddressValues($handle) {
  $values = @()
  try { $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle) } catch { return $values }
  foreach ($type in @([System.Windows.Automation.ControlType]::Edit, [System.Windows.Automation.ControlType]::ComboBox)) {
    try {
      $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
      foreach ($element in @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))) {
        try {
          $value = [string]$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
          # Offscreen is deliberately NOT checked: a minimised window reports
          # every control as offscreen, and reading the value is still valid.
          if (-not [string]::IsNullOrWhiteSpace($value)) { $values += $value }
        } catch { }
      }
    } catch { }
  }
  return $values
}

function Show-Candidates($rows) {
  $list = @()
  foreach ($row in $rows) {
    $list += @{
      processId = $row.ProcessId; windowHandle = $row.Handle.ToInt64(); title = $row.Title
      minimized = $row.Minimized; address = $row.Address
    }
  }
  return $list
}

$processIds = if ($ChromeProcessId -gt 0) { @($ChromeProcessId) } else { @(Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
$candidates = @()
foreach ($processId in $processIds) {
  foreach ($handle in [BridgeChromeWindows]::Visible($processId)) {
    if ($ChromeWindowHandle -gt 0 -and $handle.ToInt64() -ne $ChromeWindowHandle) { continue }
    $candidates += [pscustomobject]@{
      ProcessId = $processId
      Handle    = $handle
      Title     = [BridgeChromeWindows]::Title($handle)
      Minimized = [BridgeChromeWindows]::IsIconic($handle)
      Address   = $null
    }
  }
}

if ($candidates.Count -eq 0) {
  Emit @{
    status = 'failed'; retryable = $true; reason = 'no_chrome_window'; cleared = 0; dispatched = $false
    documentVisible = $false; clearedState = 'unknown'; scanned = 0
    nextStep = 'Chrome is not showing any visible window, so the error list cannot be reached. Bring a Chrome window up and call browser_reload_extension again - do not assume the panel is clean.'
  }
}

foreach ($candidate in $candidates) {
  foreach ($value in (Get-AddressValues $candidate.Handle)) {
    if ($value.StartsWith($ExpectedUrlPrefix)) { $candidate.Address = $value; break }
  }
}

$target = $null
$resolution = ''
if ($ChromeWindowHandle -gt 0) {
  $target = $candidates | Select-Object -First 1
  $resolution = 'explicit_window_handle'
} else {
  $showingErrors = @($candidates | Where-Object { $_.Address -and $_.Address.Contains($RequireUrlContains) })
  if ($showingErrors.Count -eq 1) {
    $target = $showingErrors[0]
    $resolution = 'address_bar_match'
  } elseif ($showingErrors.Count -gt 1) {
    Emit @{
      status = 'failed'; retryable = $false; reason = 'multiple_errors_pages'; cleared = 0; dispatched = $false
      documentVisible = $false; clearedState = 'unknown'; scanned = 0
      candidates = (Show-Candidates $showingErrors)
      nextStep = 'More than one Chrome window is showing the extension error list. Nothing was clicked. Close the extra one and call browser_reload_extension again, or run browser_native_snapshot with includeDocuments:true on the intended window and invoke its "Clear all" button.'
    }
  } elseif ($candidates.Count -eq 1) {
    $target = $candidates[0]
    $resolution = 'single_window'
  } else {
    Emit @{
      status = 'failed'; retryable = $false; reason = 'target_window_ambiguous'; cleared = 0; dispatched = $false
      documentVisible = $false; clearedState = 'unknown'; scanned = 0
      candidates = (Show-Candidates $candidates)
      nextStep = 'Several Chrome windows are open and none of them shows the extension error list, so no window can be identified safely and nothing was clicked. Call browser_extension_errors first to bring that page to the front, then repeat. As a last resort run browser_native_snapshot with includeDocuments:true on the intended window and invoke its "Clear all" button.'
    }
  }
}

$restoredFromMinimized = $false
if ($target.Minimized) {
  # SW_SHOWNOACTIVATE restores the window without taking the foreground. A
  # minimised window reports every descendant as offscreen, so without this the
  # walk sees nothing and would report an empty page. ShowWindow's return value
  # is the previous visibility, not the outcome, so the restore is confirmed by
  # asking the window whether it is still iconic.
  [void][BridgeChromeWindows]::ShowWindow($target.Handle, 4)
  Start-Sleep -Milliseconds 400
  $restoredFromMinimized = -not [BridgeChromeWindows]::IsIconic($target.Handle)
}

try {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($target.Handle)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
} catch {
  Emit @{
    status = 'failed'; retryable = $true; reason = 'window_unavailable'; cleared = 0; dispatched = $false
    documentVisible = $false; clearedState = 'unknown'; scanned = 0
    processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
    nextStep = 'The Chrome window disappeared before it could be read. Call browser_reload_extension again after the window is stable.'
  }
}

# Walk the whole window, documents included. The rows are what lets the caller
# tell "the list is empty" from "the page was never readable" - the two states
# used to produce the same answer.
function Walk {
  $queue = [Collections.Generic.Queue[object]]::new()
  $queue.Enqueue(@{ e = $root; d = 0 })
  $rows = [Collections.Generic.List[object]]::new()
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while ($queue.Count -gt 0) {
    if ($rows.Count -ge 900 -or $timer.ElapsedMilliseconds -ge 6000) { break }
    $item = $queue.Dequeue(); $el = $item.e; $d = $item.d
    try { $cur = $el.Current } catch { continue }
    if (-not $cur.IsOffscreen) {
      $rows.Add([pscustomobject]@{
        element = $el; role = $cur.ControlType.ProgrammaticName; name = [string]$cur.Name; depth = $d
      })
    }
    if ($d -ge 40) { continue }
    $child = $walker.GetFirstChild($el)
    while ($child) {
      $queue.Enqueue(@{ e = $child; d = ($d + 1) })
      $child = $walker.GetNextSibling($child)
    }
  }
  return $rows
}

function Find-Button($rows, [string]$name) {
  foreach ($row in $rows) {
    if ($row.role -eq 'ControlType.Button' -and $row.name -eq $name) { return $row }
  }
  return $null
}

function Count-ErrorEntries($rows) {
  return @($rows | Where-Object { $_.role -eq 'ControlType.Button' -and $_.name -like 'Error *' }).Count
}

function Invoke-Btn($row) {
  try {
    $pattern = $row.element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    return $true
  } catch { return $false }
}

function Has-Document($rows) {
  return @($rows | Where-Object { $_.role -eq 'ControlType.Document' }).Count -gt 0
}

$reloadMethod = 'none'
$rows = Walk
if (-not (Has-Document $rows)) {
  # Chrome enables its accessibility engine per document, and only while an
  # assistive-technology client is attached. A page that was already loaded has
  # no document node, so the page has to be reloaded - and the reload, the read
  # and the click all have to happen inside ONE process, because the engine is
  # already off again by the time a second process connects.
  #
  # Reloading the wrong tab would discard whatever the user has in it, so this
  # only happens after the address bar proved the front tab is the error list.
  if (-not $target.Address) {
    Emit @{
      status = 'failed'; retryable = $false; reason = 'address_unreadable'; cleared = 0; dispatched = $false
      documentVisible = $false; clearedState = 'unknown'; scanned = $rows.Count
      processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
      nextStep = 'The address bar of the Chrome window could not be read, so no page could be identified and nothing was reloaded or clicked. Call browser_extension_errors to put the error list in front, then repeat.'
    }
  }
  if (-not $target.Address.Contains($RequireUrlContains)) {
    Emit @{
      status = 'failed'; retryable = $false; reason = 'errors_page_not_front'; cleared = 0; dispatched = $false
      documentVisible = $false; clearedState = 'unknown'; scanned = $rows.Count
      processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
      address = $target.Address
      nextStep = 'The front tab of that window is not the extension error list, so reloading it would discard the user''s page and nothing was done. Call browser_extension_errors first, then repeat.'
    }
  }
  $reload = Find-Button $rows 'Reload'
  if (-not $reload) { $reload = Find-Button $rows '重新加载' }
  if (-not $reload) {
    Emit @{
      status = 'failed'; retryable = $true; reason = 'reload_control_missing'; cleared = 0; dispatched = $false
      documentVisible = $false; clearedState = 'unknown'; scanned = $rows.Count
      processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
      address = $target.Address
      nextStep = 'The browser Reload control was not in the tree, so the page could not be brought into the accessibility engine. Call browser_reload_extension again.'
    }
  }
  if (-not (Invoke-Btn $reload)) {
    Emit @{
      status = 'failed'; retryable = $true; reason = 'reload_invoke_raised'; cleared = 0; dispatched = $false
      documentVisible = $false; clearedState = 'unknown'; scanned = $rows.Count
      processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
      nextStep = 'Reload was found but its Invoke call raised. Nothing was clicked. Read the window state before retrying.'
    }
  }
  $reloadMethod = 'toolbar_reload'
  # Poll for the document instead of sleeping a fixed amount: 1800ms is enough on
  # a fast page and a coin flip on a slow one, and losing the flip produced an
  # empty walk that looked exactly like a clean error list.
  $deadline = [Diagnostics.Stopwatch]::StartNew()
  do {
    Start-Sleep -Milliseconds 200
    $rows = Walk
    if (Has-Document $rows) { break }
  } while ($deadline.ElapsedMilliseconds -lt $DocumentTimeoutMs)
  if (-not (Has-Document $rows)) {
    Emit @{
      status = 'failed'; retryable = $true; reason = 'page_not_ready'; cleared = 0; dispatched = $false
      documentVisible = $false; clearedState = 'unknown'; reloaded = $true; reloadMethod = $reloadMethod
      waitedMs = $deadline.ElapsedMilliseconds; scanned = $rows.Count
      processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
      address = $target.Address
      nextStep = 'The error list was reloaded but its content never became readable within the wait, so nothing was clicked and the state of the list is unknown. Call browser_reload_extension again - do not report the panel as clean.'
    }
  }
}

# The document is readable now. The list is rendered asynchronously inside it, so
# "no Clear all button" is only meaningful once it has had a moment to appear.
$clearDeadline = [Diagnostics.Stopwatch]::StartNew()
$clearAll = Find-Button $rows 'Clear all'
while (-not $clearAll -and $clearDeadline.ElapsedMilliseconds -lt $ClearAllTimeoutMs) {
  Start-Sleep -Milliseconds 250
  $rows = Walk
  $clearAll = Find-Button $rows 'Clear all'
}
$documentVisible = Has-Document $rows
$errorEntries = Count-ErrorEntries $rows

if (-not $documentVisible) {
  Emit @{
    status = 'failed'; retryable = $true; reason = 'page_not_ready'; cleared = 0; dispatched = $false
    documentVisible = $false; clearedState = 'unknown'; reloaded = ($reloadMethod -ne 'none'); reloadMethod = $reloadMethod
    waitedMs = $clearDeadline.ElapsedMilliseconds; scanned = $rows.Count
    processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
    nextStep = 'The page stopped being readable before the error list could be read. Nothing was clicked. Call browser_reload_extension again.'
  }
}

if (-not $clearAll) {
  Emit @{
    status = 'nothing_to_clear'; cleared = 0; dispatched = $false; retryable = $false
    reloaded = ($reloadMethod -ne 'none'); reloadMethod = $reloadMethod
    documentVisible = $true; clearedState = 'empty'; errorEntries = $errorEntries
    waitedMs = $clearDeadline.ElapsedMilliseconds; scanned = $rows.Count
    processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
    restoredFromMinimized = $restoredFromMinimized
    note = 'The error list was read successfully and has no "Clear all" control, which is what the page shows when the list is empty.'
  }
}

$dispatched = Invoke-Btn $clearAll
if (-not $dispatched) {
  Emit @{
    status = 'failed'; retryable = $false; reason = 'invoke_raised'; cleared = 0; dispatched = $false
    documentVisible = $true; clearedState = 'unknown'; errorEntries = $errorEntries; scanned = $rows.Count
    processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
    nextStep = 'The Clear all button was found but its Invoke call raised, so the outcome is unknown and repeating it blindly is not safe. Read the page again before deciding.'
  }
}

# The button leaving the tree is the evidence the click landed, exactly like the
# invoke post-condition the native action tool requires.
$settle = [Diagnostics.Stopwatch]::StartNew()
$after = $null
while ($settle.ElapsedMilliseconds -lt $SettleTimeoutMs) {
  Start-Sleep -Milliseconds 250
  $after = Walk
  if (-not (Find-Button $after 'Clear all')) { break }
}
$stillThere = $null -ne (Find-Button $after 'Clear all')
$remaining = Count-ErrorEntries $after

Emit @{
  status = $(if ($stillThere) { 'uncertain' } else { 'cleared' })
  cleared = $(if ($stillThere) { 0 } else { 1 })
  retryable = $false
  dispatched = $true
  reloaded = ($reloadMethod -ne 'none')
  reloadMethod = $reloadMethod
  documentVisible = $true
  clearedState = $(if ($stillThere) { 'unknown' } else { 'empty' })
  errorEntriesBefore = $errorEntries
  errorEntriesAfter = $remaining
  settleMs = $settle.ElapsedMilliseconds
  controlGone = (-not $stillThere)
  scanned = $after.Count
  processId = $target.ProcessId
  windowHandle = $target.Handle.ToInt64()
  targetResolution = $resolution
  restoredFromMinimized = $restoredFromMinimized
  address = $target.Address
}
