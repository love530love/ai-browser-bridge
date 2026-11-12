param(
  [string]$ExtensionId = '',
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

# The Node caller (src/extension-errors.js) binds the id to this project's
# extension/ directory before invoking this script. Never fall back to a
# hard-coded id, and never act on an unvalidated one.
if ($ExtensionId -notmatch '^[a-p]{32}$') {
  Emit @{ status = 'failed'; retryable = $false; reason = 'extension_id_not_bound'; cleared = 0; dispatched = $false
    note = 'An explicit validated extension id is required; no UI action was taken.' }
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
    nextStep = 'Chrome is not showing any visible window, so the error list could not be read. The list state is unknown, not proof that errors remain; the extension reload itself may already have succeeded. Verify with browser_extension_errors (read-only) once a Chrome window is visible. Do not repeat browser_reload_extension to clear this result - that reloads the extension a second time; only do it deliberately after the preconditions change.'
  }
}

foreach ($candidate in $candidates) {
  # Keep the FIRST address value even when it is not chrome://extensions. The
  # old loop only assigned on a prefix match, so a window on an ordinary web
  # page reported address:null and nobody could tell "address bar unreadable"
  # from "wrong page in front".
  $values = @(Get-AddressValues $candidate.Handle)
  if ($values.Count -gt 0) { $candidate.Address = $values[0] }
  foreach ($value in $values) {
    if ($value.StartsWith($ExpectedUrlPrefix)) { $candidate.Address = $value; break }
  }
}

$target = $null
$resolution = ''
if ($ChromeWindowHandle -gt 0) {
  $target = $candidates | Select-Object -First 1
  $resolution = 'explicit_window_handle'
} else {
  $showingErrors = @($candidates | Where-Object { $_.Address -and $_.Address.StartsWith($ExpectedUrlPrefix) })
  if ($showingErrors.Count -eq 1) {
    $target = $showingErrors[0]
    $resolution = 'address_bar_match'
  } elseif ($showingErrors.Count -gt 1) {
    Emit @{
      status = 'failed'; retryable = $false; reason = 'multiple_errors_pages'; cleared = 0; dispatched = $false
      documentVisible = $false; clearedState = 'unknown'; scanned = 0
      candidates = (Show-Candidates $showingErrors)
      nextStep = 'More than one Chrome window is showing the extension error list, so no window was chosen and nothing was clicked. The list state is unknown, not proof that errors remain; the extension reload itself may already have succeeded. Close the extra window, then verify with browser_extension_errors (read-only). Do not repeat browser_reload_extension to clear this result - that reloads the extension a second time; only do it deliberately after the preconditions change.'
    }
  } elseif ($candidates.Count -eq 1) {
    $target = $candidates[0]
    $resolution = 'single_window'
  } else {
    Emit @{
      status = 'failed'; retryable = $false; reason = 'target_window_ambiguous'; cleared = 0; dispatched = $false
      documentVisible = $false; clearedState = 'unknown'; scanned = 0
      candidates = (Show-Candidates $candidates)
      nextStep = 'Several Chrome windows are open and none of them shows the extension error list, so no window can be identified safely and nothing was clicked. The list state is unknown, not proof that errors remain; the extension reload itself may already have succeeded. Call browser_extension_errors (read-only) to put the error list in front of the intended window, then read it. Do not repeat browser_reload_extension to clear this result - that reloads the extension a second time; only do it deliberately after the preconditions change.'
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
    nextStep = 'The Chrome window disappeared before it could be read. The list state is unknown, not proof that errors remain; the extension reload itself may already have succeeded. Once a window is stable, verify with browser_extension_errors (read-only). Do not repeat browser_reload_extension to clear this result - that reloads the extension a second time; only do it deliberately after the preconditions change.'
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

# "Clear all" is localised. Chrome's toolbar Reload control already needed a
# zh-CN alias, and leaving the clear button English-only made a non-empty error
# list invisible on a Chinese UI: the walk found no button and reported an empty
# list. Both names are tried so the result can say what was actually matched.
$CLEAR_ALL_NAMES = @('Clear all', '全部清除', '清除全部', '全部清空')
function Find-ClearAllButton($rows) {
  foreach ($name in $CLEAR_ALL_NAMES) {
    $found = Find-Button $rows $name
    if ($found) { return $found }
  }
  return $null
}

$ERROR_ENTRY_PATTERNS = @('Error *', '错误 *', '错误*')
function Count-ErrorEntries($rows) {
  $count = 0
  foreach ($row in $rows) {
    if ($row.role -ne 'ControlType.Button') { continue }
    foreach ($pattern in $ERROR_ENTRY_PATTERNS) {
      if ($row.name -like $pattern) { $count++; break }
    }
  }
  return $count
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

# ---------------------------------------------------------------------------
# Unconditional target verification.
#
# This used to live INSIDE the "no document node" branch. That was a silent
# false-clean: when the front tab was an ordinary web page (CSDN, mail, ...),
# the walk found a Document, the address-bar check was skipped entirely, and
# the absence of a "Clear all" button on that unrelated page was reported as
# nothing_to_clear. Downstream describeErrorList() treats that as clean, so a
# red error list survived while the caller was told it had been cleared.
#
# The page identity is now proved before ANY read of the error list, and it is
# carried into the result so no layer has to trust an unverified "empty" verdict.
# chrome://extensions/?errors=<id> is sometimes shortened by the omnibox, so
# the prefix is required and the errors= part is recorded but not demanded.
# ---------------------------------------------------------------------------
$addressVerified = $false
if ($target.Address -and $target.Address.StartsWith($ExpectedUrlPrefix)) { $addressVerified = $true }
if (-not $addressVerified) {
  Emit @{
    status = 'failed'; retryable = $false; reason = 'errors_page_not_front'; cleared = 0; dispatched = $false
    documentVisible = $false; clearedState = 'unknown'; scanned = 0
    processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
    address = $target.Address; addressVerified = $false
    candidates = (Show-Candidates $candidates)
    nextStep = 'The front tab of the selected window is not chrome://extensions, so this is not the extension error list. Nothing was read and nothing was clicked. The list state is unknown, not proof that errors remain; the extension reload itself may already have succeeded. Call browser_extension_errors (read-only) to put the error list in front, then read it, and do not report the panel as clean. Do not repeat browser_reload_extension to clear this result - that reloads the extension a second time; only do it deliberately after the preconditions change. If the connected extension belongs to a different browser host, this page belongs to the wrong browser entirely.'
  }
}
$errorsQueryVisible = $false
if ($target.Address -and $target.Address.Contains($RequireUrlContains)) { $errorsQueryVisible = $true }

$reloadMethod = 'none'
$rows = Walk
if (-not (Has-Document $rows)) {
  # Chrome enables its accessibility engine per document, and only while an
  # assistive-technology client is attached. A page that was already loaded has
  # no document node, so the page has to be reloaded - and the reload, the read
  # and the click all have to happen inside ONE process, because the engine is
  # already off again by the time a second process connects. The address bar
  # was already verified above, so reloading cannot discard a user page here.
  $reload = Find-Button $rows 'Reload'
  if (-not $reload) { $reload = Find-Button $rows '重新加载' }
  if (-not $reload) {
    Emit @{
      status = 'failed'; retryable = $true; reason = 'reload_control_missing'; cleared = 0; dispatched = $false
      documentVisible = $false; clearedState = 'unknown'; scanned = $rows.Count
      processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
      address = $target.Address
      nextStep = 'The browser Reload control was not in the tree, so the error list page could not be brought into the accessibility engine. The list state is unknown, not proof that errors remain; the extension reload itself may already have succeeded. Verify with browser_extension_errors (read-only) once the page is readable. Do not repeat browser_reload_extension to clear this result - that reloads the extension a second time; only do it deliberately after the preconditions change.'
    }
  }
  if (-not (Invoke-Btn $reload)) {
    Emit @{
      status = 'failed'; retryable = $true; reason = 'reload_invoke_raised'; cleared = 0; dispatched = $false
      documentVisible = $false; clearedState = 'unknown'; scanned = $rows.Count
      processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
      nextStep = 'Reload was found but its Invoke call raised, so the outcome of that click is unknown; the list state is unknown, not proof that errors remain, and the extension reload itself may already have succeeded. Do not repeat browser_reload_extension to clear this result - that reloads the extension a second time, and an uncertain click must be re-observed before any retry. Verify with browser_extension_errors (read-only) once the page is readable.'
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
      nextStep = 'The error list was reloaded but its content never became readable within the wait, so nothing was clicked. The list state is unknown, not proof that errors remain; the extension reload itself may already have succeeded. Verify with browser_extension_errors (read-only) once the page is readable, and do not report the panel as clean. Do not repeat browser_reload_extension to clear this result - that reloads the extension a second time; only do it deliberately after the preconditions change.'
    }
  }
}

# The document is readable now. The list is rendered asynchronously inside it, so
# "no Clear all button" is only meaningful once it has had a moment to appear.
$clearDeadline = [Diagnostics.Stopwatch]::StartNew()
$clearAll = Find-ClearAllButton $rows
while (-not $clearAll -and $clearDeadline.ElapsedMilliseconds -lt $ClearAllTimeoutMs) {
  Start-Sleep -Milliseconds 250
  $rows = Walk
  $clearAll = Find-ClearAllButton $rows
}
$documentVisible = Has-Document $rows
$errorEntries = Count-ErrorEntries $rows

if (-not $documentVisible) {
  Emit @{
    status = 'failed'; retryable = $true; reason = 'page_not_ready'; cleared = 0; dispatched = $false
    documentVisible = $false; clearedState = 'unknown'; reloaded = ($reloadMethod -ne 'none'); reloadMethod = $reloadMethod
    waitedMs = $clearDeadline.ElapsedMilliseconds; scanned = $rows.Count
    processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
    nextStep = 'The page stopped being readable before the error list could be read, so nothing was clicked. The list state is unknown, not proof that errors remain; the extension reload itself may already have succeeded. Verify with browser_extension_errors (read-only) once the page is readable. Do not repeat browser_reload_extension to clear this result - that reloads the extension a second time; only do it deliberately after the preconditions change.'
  }
}

if (-not $clearAll) {
  # Raw evidence, not a verdict. A "no button found" conclusion is only as
  # trustworthy as the tree it came from, so the caller gets the button names
  # that WERE present. This is what makes a false clean auditable: if the walk
  # saw a CSDN page's buttons, the list is obviously not the extension's.
  $buttonNames = @($rows | Where-Object { $_.role -eq 'ControlType.Button' -and $_.name } |
    ForEach-Object { [string]$_.name } | Select-Object -Unique | Select-Object -First 40)
  Emit @{
    status = 'nothing_to_clear'; cleared = 0; dispatched = $false; retryable = $false
    reloaded = ($reloadMethod -ne 'none'); reloadMethod = $reloadMethod
    documentVisible = $true; clearedState = 'empty'; errorEntries = $errorEntries
    addressVerified = $addressVerified; errorsQueryVisible = $errorsQueryVisible; address = $target.Address
    clearButtonNames = $CLEAR_ALL_NAMES; observedButtonNames = $buttonNames
    waitedMs = $clearDeadline.ElapsedMilliseconds; scanned = $rows.Count
    processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
    restoredFromMinimized = $restoredFromMinimized
    note = 'The address bar was verified as chrome://extensions and the document was readable; no localised "Clear all" control appeared, which is what the page shows when the list is empty.'
  }
}

$dispatched = Invoke-Btn $clearAll
if (-not $dispatched) {
  Emit @{
    status = 'failed'; retryable = $false; reason = 'invoke_raised'; cleared = 0; dispatched = $false
    documentVisible = $true; clearedState = 'unknown'; errorEntries = $errorEntries; scanned = $rows.Count
    processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
    nextStep = 'The Clear all button was found but its Invoke call raised, so the outcome is unknown; the list state is unknown, not proof that errors remain, and the extension reload itself may already have succeeded. Do not repeat browser_reload_extension to clear this result - that reloads the extension a second time, and an uncertain write must never be replayed blindly. Verify with browser_extension_errors (read-only) by reading the page before deciding.'
  }
}

# The button leaving the tree is the evidence the click landed, exactly like the
# invoke post-condition the native action tool requires.
$settle = [Diagnostics.Stopwatch]::StartNew()
$after = $null
while ($settle.ElapsedMilliseconds -lt $SettleTimeoutMs) {
  Start-Sleep -Milliseconds 250
  $after = Walk
  if (-not (Find-ClearAllButton $after)) { break }
}
$stillThere = $null -ne (Find-ClearAllButton $after)
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
  addressVerified = $addressVerified; errorsQueryVisible = $errorsQueryVisible; address = $target.Address
  clearButtonName = [string]$clearAll.name
  scanned = $after.Count
  processId = $target.ProcessId
  windowHandle = $target.Handle.ToInt64()
  targetResolution = $resolution
  restoredFromMinimized = $restoredFromMinimized
}
