param([Parameter(Mandatory)][int]$ChromeProcessId, [Parameter(Mandatory)][long]$ChromeWindowHandle)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes

function Emit($payload) {
  $payload | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

$handle = [intptr]$ChromeWindowHandle
try {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
} catch {
  Emit @{ status = 'failed'; reason = 'window_unavailable'; cleared = 0; dispatched = $false }
}

# Walk the whole window, documents included. Returns the controls it saw so the
# caller can tell "no errors left" from "the page was never readable".
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
  foreach ($r in $rows) {
    if ($r.role -eq 'ControlType.Button' -and $r.name -eq $name) { return $r }
  }
  return $null
}

function Invoke-Btn($row) {
  try {
    $p = $row.element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $p.Invoke()
    return $true
  } catch { return $false }
}

# Chrome enables its accessibility engine per document, and only while an
# assistive-technology client is attached. Two consequences shape this script:
# the reload and the read have to happen inside ONE process, or the engine is
# already off again by the time the second one connects; and a page that was
# already loaded has to be reloaded, because navigating to the URL it is already
# on creates no document. Measured before this existed: 86 controls and zero
# Document nodes, forever.
$before = Walk
$hasDoc = @($before | Where-Object { $_.role -eq 'ControlType.Document' }).Count -gt 0
$reloaded = $false
if (-not $hasDoc) {
  $reload = Find-Button $before 'Reload'
  if ($reload) {
    $reloaded = Invoke-Btn $reload
    Start-Sleep -Milliseconds 1800
  }
}
$rows = Walk
$hasDoc = @($rows | Where-Object { $_.role -eq 'ControlType.Document' }).Count -gt 0

$clearAll = Find-Button $rows 'Clear all'
$errorEntries = @($rows | Where-Object { $_.role -eq 'ControlType.Button' -and $_.name -like 'Error *' }).Count

if (-not $clearAll) {
  Emit @{
    status = 'nothing_to_clear'; cleared = 0; dispatched = $false; reloaded = $reloaded
    documentVisible = $hasDoc; errorEntries = $errorEntries; scanned = $rows.Count
    note = 'No "Clear all" button is present, which is what the page shows when the list is already empty.'
  }
}

$dispatched = Invoke-Btn $clearAll
if (-not $dispatched) {
  Emit @{
    status = 'failed'; reason = 'invoke_raised'; cleared = 0; dispatched = $false; reloaded = $reloaded
    documentVisible = $hasDoc; errorEntries = $errorEntries; scanned = $rows.Count
    message = 'The Clear all button was found but the Invoke call raised. Read the page again before retrying; do not repeat blindly.'
  }
}

# The button leaving the tree is the evidence the click landed, exactly like the
# invoke post-condition the native action tool requires.
$settle = [Diagnostics.Stopwatch]::StartNew()
$after = $null
while ($settle.ElapsedMilliseconds -lt 3000) {
  Start-Sleep -Milliseconds 250
  $after = Walk
  if (-not (Find-Button $after 'Clear all')) { break }
}
$stillThere = $null -ne (Find-Button $after 'Clear all')
$remaining = @($after | Where-Object { $_.role -eq 'ControlType.Button' -and $_.name -like 'Error *' }).Count

Emit @{
  status = $(if ($stillThere) { 'uncertain' } else { 'cleared' })
  cleared = $(if ($stillThere) { 0 } else { 1 })
  dispatched = $true
  reloaded = $reloaded
  documentVisible = $hasDoc
  errorEntriesBefore = $errorEntries
  errorEntriesAfter = $remaining
  settleMs = $settle.ElapsedMilliseconds
  controlGone = (-not $stillThere)
  scanned = $after.Count
}
