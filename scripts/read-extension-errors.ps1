param(
  [string]$ExtensionId = '',
  [int]$ChromeProcessId = 0,
  [long]$ChromeWindowHandle = 0,
  [string]$ExpectedUrlPrefix = 'chrome://extensions',
  [string]$RequireUrlContains = '',
  [ValidateRange(1000, 30000)][int]$DocumentTimeoutMs = 9000,
  [ValidateRange(500, 15000)][int]$ReadTimeoutMs = 5000
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes

# Read-only sibling of clear-extension-errors.ps1. Same target resolution and
# same one-process reload (Chrome enables accessibility per document, only while
# a client is attached), but this script never invokes "Clear all" and never
# changes the error store. It exists so "is the panel actually red?" has an
# evidenced answer instead of "unknown because no window was found".
function Emit($payload) {
  $payload | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

if ($ExtensionId -notmatch '^[a-p]{32}$') {
  Emit @{ status = 'failed'; retryable = $false; reason = 'extension_id_not_bound'; state = 'unknown'; hasErrors = $null
    note = 'An explicit validated extension id is required; no UI action was taken.' }
}
if ([string]::IsNullOrWhiteSpace($RequireUrlContains)) { $RequireUrlContains = "errors=$ExtensionId" }

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BridgeChromeWindowsRead {
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

function Get-AddressValues($handle) {
  $values = @()
  try { $rootElement = [System.Windows.Automation.AutomationElement]::FromHandle($handle) } catch { return $values }
  foreach ($type in @([System.Windows.Automation.ControlType]::Edit, [System.Windows.Automation.ControlType]::ComboBox)) {
    try {
      $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
      foreach ($element in @($rootElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))) {
        try {
          $value = [string]$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
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
  foreach ($handle in [BridgeChromeWindowsRead]::Visible($processId)) {
    if ($ChromeWindowHandle -gt 0 -and $handle.ToInt64() -ne $ChromeWindowHandle) { continue }
    $candidates += [pscustomobject]@{
      ProcessId = $processId
      Handle    = $handle
      Title     = [BridgeChromeWindowsRead]::Title($handle)
      Minimized = [BridgeChromeWindowsRead]::IsIconic($handle)
      Address   = $null
    }
  }
}

if ($candidates.Count -eq 0) {
  Emit @{
    status = 'failed'; retryable = $true; reason = 'no_chrome_window'; state = 'unknown'; hasErrors = $null
    documentVisible = $false; scanned = 0
    nextStep = 'No visible browser window belongs to the connected host, so the error list could not be read. Its state is unknown, not proof that errors remain. If this host is an embedded browser with no window, there is no chrome://extensions surface to read; report that limit instead of opening a different browser.'
  }
}

foreach ($candidate in $candidates) {
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
      status = 'failed'; retryable = $false; reason = 'multiple_errors_pages'; state = 'unknown'; hasErrors = $null
      documentVisible = $false; scanned = 0
      candidates = (Show-Candidates $showingErrors)
      nextStep = 'More than one window is showing the extension error list, so no window was chosen. Read state is unknown; call browser_extension_errors action:"open" to put one specific page in front, then read again.'
    }
  } elseif ($candidates.Count -eq 1) {
    $target = $candidates[0]
    $resolution = 'single_window'
  } else {
    Emit @{
      status = 'failed'; retryable = $false; reason = 'target_window_ambiguous'; state = 'unknown'; hasErrors = $null
      documentVisible = $false; scanned = 0
      candidates = (Show-Candidates $candidates)
      nextStep = 'Several windows are open and none shows the extension error list. Read state is unknown; call browser_extension_errors action:"open" first, then read.'
    }
  }
}

$restoredFromMinimized = $false
if ($target.Minimized) {
  [void][BridgeChromeWindowsRead]::ShowWindow($target.Handle, 4)
  Start-Sleep -Milliseconds 400
  $restoredFromMinimized = -not [BridgeChromeWindowsRead]::IsIconic($target.Handle)
}

try {
  $rootElement = [System.Windows.Automation.AutomationElement]::FromHandle($target.Handle)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
} catch {
  Emit @{
    status = 'failed'; retryable = $true; reason = 'window_unavailable'; state = 'unknown'; hasErrors = $null
    documentVisible = $false; scanned = 0
    processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
    nextStep = 'The window disappeared before it could be read. Read state is unknown; re-open the error page with browser_extension_errors action:"open", then read again.'
  }
}

function Walk {
  $queue = [Collections.Generic.Queue[object]]::new()
  $queue.Enqueue(@{ e = $rootElement; d = 0 })
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

$CLEAR_ALL_NAMES = @('Clear all', '全部清除', '清除全部', '全部清空')
function Find-ClearAllButton($rows) {
  foreach ($name in $CLEAR_ALL_NAMES) {
    $found = Find-Button $rows $name
    if ($found) { return $found }
  }
  return $null
}

$ERROR_ENTRY_PATTERNS = @('Error *', '错误 *', '错误*')
function Get-ErrorEntries($rows) {
  $entries = @()
  foreach ($row in $rows) {
    if ($row.role -ne 'ControlType.Button' -or [string]::IsNullOrWhiteSpace($row.name)) { continue }
    foreach ($pattern in $ERROR_ENTRY_PATTERNS) {
      if ($row.name -like $pattern) {
        $name = [string]$row.name
        if ($name.Length -gt 500) { $name = $name.Substring(0, 500) }
        $entries += $name
        break
      }
    }
  }
  return $entries
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

$addressVerified = $false
if ($target.Address -and $target.Address.StartsWith($ExpectedUrlPrefix)) { $addressVerified = $true }
if (-not $addressVerified) {
  Emit @{
    status = 'failed'; retryable = $false; reason = 'errors_page_not_front'; state = 'unknown'; hasErrors = $null
    documentVisible = $false; scanned = 0
    processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
    address = $target.Address; addressVerified = $false
    candidates = (Show-Candidates $candidates)
    nextStep = 'The selected window is not showing chrome://extensions, so there is no error list to read. Nothing was clicked. Call browser_extension_errors action:"open" first, then read. If the connected host is a different browser, this page belongs to the wrong browser.'
  }
}
$errorsQueryVisible = $false
if ($target.Address -and $target.Address.Contains($RequireUrlContains)) { $errorsQueryVisible = $true }

$pageReloadPerformed = $false
$rows = Walk
if (-not (Has-Document $rows)) {
  $reload = Find-Button $rows 'Reload'
  if (-not $reload) { $reload = Find-Button $rows '重新加载' }
  if (-not $reload) {
    Emit @{
      status = 'failed'; retryable = $true; reason = 'reload_control_missing'; state = 'unknown'; hasErrors = $null
      documentVisible = $false; scanned = $rows.Count
      processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
      address = $target.Address
      nextStep = 'The browser Reload control was not in the tree, so the page never entered the accessibility engine. Read state is unknown; retry once after the window is fully visible.'
    }
  }
  if (-not (Invoke-Btn $reload)) {
    Emit @{
      status = 'failed'; retryable = $true; reason = 'reload_invoke_raised'; state = 'unknown'; hasErrors = $null
      documentVisible = $false; scanned = $rows.Count
      processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
      nextStep = 'Reload was found but its Invoke call raised, so the page state is unknown. Re-observe before any retry; do not report the panel as clean or red.'
    }
  }
  $pageReloadPerformed = $true
  $deadline = [Diagnostics.Stopwatch]::StartNew()
  do {
    Start-Sleep -Milliseconds 200
    $rows = Walk
    if (Has-Document $rows) { break }
  } while ($deadline.ElapsedMilliseconds -lt $DocumentTimeoutMs)
  if (-not (Has-Document $rows)) {
    Emit @{
      status = 'failed'; retryable = $true; reason = 'page_not_ready'; state = 'unknown'; hasErrors = $null
      documentVisible = $false; pageReloadPerformed = $true; waitedMs = $deadline.ElapsedMilliseconds; scanned = $rows.Count
      processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
      address = $target.Address
      nextStep = 'The page was reloaded but never became readable, so nothing was read. State is unknown; retry once, and never report the panel as clean on this result.'
    }
  }
}

# The list renders asynchronously inside the document. Wait for either signal
# (a Clear all control or an error row) to appear before deciding "empty".
$readDeadline = [Diagnostics.Stopwatch]::StartNew()
$clearAll = Find-ClearAllButton $rows
$errorEntries = @(Get-ErrorEntries $rows)
while (-not $clearAll -and $errorEntries.Count -eq 0 -and $readDeadline.ElapsedMilliseconds -lt $ReadTimeoutMs) {
  Start-Sleep -Milliseconds 250
  $rows = Walk
  $clearAll = Find-ClearAllButton $rows
  $errorEntries = @(Get-ErrorEntries $rows)
}

$documentVisible = Has-Document $rows
if (-not $documentVisible) {
  Emit @{
    status = 'failed'; retryable = $true; reason = 'page_not_ready'; state = 'unknown'; hasErrors = $null
    documentVisible = $false; pageReloadPerformed = $pageReloadPerformed; waitedMs = $readDeadline.ElapsedMilliseconds; scanned = $rows.Count
    processId = $target.ProcessId; windowHandle = $target.Handle.ToInt64(); targetResolution = $resolution
    nextStep = 'The page stopped being readable before the list state was decided. State is unknown, not proof that errors remain; re-open and read again.'
  }
}

$buttonNames = @($rows | Where-Object { $_.role -eq 'ControlType.Button' -and $_.name } |
  ForEach-Object { [string]$_.name } | Select-Object -Unique | Select-Object -First 40)
$hasErrors = ($null -ne $clearAll) -or ($errorEntries.Count -gt 0)
$state = if ($hasErrors) { 'errors_present' } else { 'empty' }

Emit @{
  status = 'success'
  state = $state
  hasErrors = $hasErrors
  errorEntries = $errorEntries.Count
  errorEntryNames = @($errorEntries | Select-Object -First 40)
  clearButtonPresent = ($null -ne $clearAll)
  documentVisible = $true
  addressVerified = $addressVerified
  errorsQueryVisible = $errorsQueryVisible
  address = $target.Address
  pageReloadPerformed = $pageReloadPerformed
  readWaitedMs = $readDeadline.ElapsedMilliseconds
  scanned = $rows.Count
  observedButtonNames = $buttonNames
  processId = $target.ProcessId
  windowHandle = $target.Handle.ToInt64()
  targetResolution = $resolution
  restoredFromMinimized = $restoredFromMinimized
  dispatched = $false
  retryable = $false
  note = 'Read-only: the Clear all control was observed but never invoked. state=empty requires a verified chrome://extensions page and a readable document after a bounded settle wait.'
}
