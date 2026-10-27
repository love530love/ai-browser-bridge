param(
  [Parameter(Mandatory)][int]$ChromeProcessId,
  [Parameter(Mandatory)][long]$ChromeWindowHandle,
  [ValidateSet('observe','select_panel')][string]$Action = 'observe',
  [string]$ExpectedUrl = '',
  [string]$Panel = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DevToolsWindow {
 public delegate bool EnumProc(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr p);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 public static bool HasDetachedTools(int targetProcessId) {
  bool found=false;
  EnumWindows((h,p)=>{ if(!IsWindowVisible(h)) return true;
   uint id; GetWindowThreadProcessId(h,out id);
   if(id != (uint)targetProcessId) return true;
   try { if(System.Diagnostics.Process.GetProcessById((int)id).ProcessName != "chrome") return true; } catch { return true; }
   var s=new System.Text.StringBuilder(512); GetWindowText(h,s,512);
   if(System.Text.RegularExpressions.Regex.IsMatch(s.ToString(), "^(DevTools|Developer Tools|开发者工具)", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) found=true;
   return true;
  },IntPtr.Zero); return found;
 }
}
'@
$dispatched = $false
function Result($status, $reason, $evidence) {
  @{status=$status;reason=$reason;dispatched=$script:dispatched;verified=($status -eq 'success');retryable=$false;evidence=$evidence} | ConvertTo-Json -Depth 8 -Compress
}
function Observe {
  $handle = [intptr]$ChromeWindowHandle
  [uint32]$owner = 0
  $null = [DevToolsWindow]::GetWindowThreadProcessId($handle, [ref]$owner)
  $process = Get-Process -Id $ChromeProcessId -ErrorAction Stop
  if ($owner -ne $ChromeProcessId -or $process.ProcessName -ne 'chrome' -or
      [IO.Path]::GetFileName($process.Path) -ne 'chrome.exe' -or -not [DevToolsWindow]::IsWindowVisible($handle)) { throw 'chrome_target_changed' }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $stack = [Collections.Generic.Stack[System.Windows.Automation.AutomationElement]]::new()
  $stack.Push($root)
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $count = 0; $urls = @(); $devtoolsDocuments = @(); $pageDocuments = @(); $panels = @(); $selectedPanels = @()
  $script:panelControls = @()
  while ($stack.Count -gt 0 -and $count -lt 2500 -and $timer.ElapsedMilliseconds -lt 3500) {
    $item = $stack.Pop(); $count++
    $current = $item.Current
    if (-not $current.IsOffscreen) {
      $kind = $current.ControlType.ProgrammaticName
      if ($kind -in @('ControlType.Edit', 'ControlType.ComboBox')) {
        # Browser address controls vary by Chrome version. Exclude all page
        # descendants instead of trusting an AutomationId prefix or page text.
        $ancestor = $walker.GetParent($item); $insideDocument = $false; $depth = 0
        while ($ancestor -and $depth -lt 32) {
          if ($ancestor.Current.ControlType.ProgrammaticName -eq 'ControlType.Document') { $insideDocument = $true; break }
          $ancestor = $walker.GetParent($ancestor); $depth++
        }
        if (-not $insideDocument -and $depth -lt 32) {
        try { $value = $item.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
          # Chrome may omit the scheme in its native address field. Preserve
          # the observed display string rather than inventing an origin.
          if ($value -match '^(https?://|chrome://|file://|(?:[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?:[/?:]|$))') { $urls += $value }
        } catch { }
        }
      }
      if ($kind -eq 'ControlType.Document') {
        try { $value = [string]$item.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
          if ($value -match '^devtools://') { $devtoolsDocuments += $value }
          elseif ($value) { $pageDocuments += $value }
        } catch { }
      }
      if ($kind -eq 'ControlType.TabItem') {
        # Match any native DevTools tab, independent of language. A webpage's
        # ARIA tabs must never be mistaken for developer-tool controls.
        $ancestor = $walker.GetParent($item); $depth = 0; $insideTools = $false
        while ($ancestor -and $depth -lt 32) {
          if ($ancestor.Current.ControlType.ProgrammaticName -eq 'ControlType.Document') {
            try { $documentUrl = $ancestor.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
              $insideTools = $documentUrl -match '^devtools://'
            } catch { }
            break
          }
          $ancestor = $walker.GetParent($ancestor); $depth++
        }
        if ($insideTools) {
          $panels += $current.Name
          $script:panelControls += $item
          try { if ($item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) { $selectedPanels += $current.Name } } catch { }
        }
      }
    }
    $child = $walker.GetFirstChild($item)
    while ($child -and $stack.Count -lt 2500 -and $timer.ElapsedMilliseconds -lt 3500) { $stack.Push($child); $child = $walker.GetNextSibling($child) }
    if ($child) { break }
  }
  $urlValues = @($urls | Select-Object -Unique)
  $url = if ($urlValues.Count -eq 1) { $urlValues[0] } else { $null }
  $panelValues = @($panels | Select-Object -Unique)
  $selectedValues = @($selectedPanels | Select-Object -Unique)
  # A title or a page button saying Console is not evidence of DevTools.
  $open = $devtoolsDocuments.Count -gt 0 -and $panelValues.Count -ge 2
  $complete = $stack.Count -eq 0 -and $count -lt 2500 -and $timer.ElapsedMilliseconds -lt 3500
  $detached = [DevToolsWindow]::HasDetachedTools($ChromeProcessId)
  # Some Chrome builds expose a Document's accessible name rather than its URL.
  # Bind the current omnibox value to the caller's fresh browser observation and
  # require a page Document; do not require the Document ValuePattern to be a URL.
  $pageMatchesTarget = $ExpectedUrl -and $url -eq $ExpectedUrl -and $pageDocuments.Count -gt 0
  # Missing UIA elements are not proof that DevTools is closed. We only claim
  # open on positive evidence and keep every other state unknown.
  $state = if ($open) { 'open' } else { 'unknown' }
  return @{windowHandle=$ChromeWindowHandle;processId=$ChromeProcessId;url=$url;devtoolsOpen=($state -eq 'open');devtoolsState=$state;panels=$panelValues;selectedPanels=$selectedValues;partial=(-not $complete);detachedDevtools=$detached;pageDocumentCount=$pageDocuments.Count;nodesVisited=$count;targetBinding='selected Chrome window; docked DevTools only; detached DevTools requires explicit binding'}
}
try {
  $before = Observe
  if ($Action -eq 'observe') { Result 'success' 'desktop_observed' $before; exit 0 }
  if (-not $ExpectedUrl -or $before.url -ne $ExpectedUrl) { Result 'not_dispatched' 'target_url_mismatch' $before; exit 0 }
  if ($Action -eq 'select_panel') {
    if (-not $before.devtoolsOpen -or $before.partial -or -not $Panel) { Result 'not_dispatched' 'devtools_panel_unavailable' $before; exit 0 }
    if ($before.selectedPanels -ccontains $Panel) { Result 'success' 'panel_already_selected' $before; exit 0 }
    $fresh = Observe
    if ($fresh.url -ne $ExpectedUrl -or $fresh.partial -or -not $fresh.devtoolsOpen) { Result 'not_dispatched' 'target_changed' $fresh; exit 0 }
    $matches = @($script:panelControls | Where-Object { $_.Current.Name -ceq $Panel -and $_.Current.IsEnabled -and -not $_.Current.IsOffscreen })
    if ($matches.Count -ne 1) { Result 'not_dispatched' 'panel_not_unique_or_visible' $fresh; exit 0 }
    $pattern = $null
    if (-not $matches[0].TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { Result 'not_dispatched' 'panel_selection_pattern_unavailable' $fresh; exit 0 }
    $script:dispatched = $true
    $pattern.Select()
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
      Start-Sleep -Milliseconds 250
      $after = Observe
      if ($after.url -eq $ExpectedUrl -and $after.devtoolsOpen -and $after.selectedPanels -ccontains $Panel) { Result 'success' 'panel_selected_verified' $after; exit 0 }
    }
    Result 'uncertain' 'panel_selection_unverified' $after; exit 0
  }
  Result 'not_dispatched' 'action_not_implemented' $before; exit 0
} catch {
  Result $(if ($dispatched) {'uncertain'} else {'not_dispatched'}) 'desktop_observation_failed' $null
}
