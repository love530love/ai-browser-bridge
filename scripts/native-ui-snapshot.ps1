param([Parameter(Mandatory)][int]$ChromeProcessId, [Parameter(Mandatory)][long]$ChromeWindowHandle, [switch]$IncludeDocuments)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeSnapshotWindow {
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
'@
try {
  $handle=[intptr]$ChromeWindowHandle; [uint32]$owner=0
  $null=[NativeSnapshotWindow]::GetWindowThreadProcessId($handle,[ref]$owner)
  $process=Get-Process -Id $ChromeProcessId -ErrorAction Stop
  if ($owner -ne $ChromeProcessId -or $process.ProcessName -ne 'chrome' -or [IO.Path]::GetFileName($process.Path) -ine 'chrome.exe' -or -not [NativeSnapshotWindow]::IsWindowVisible($handle)) { throw 'Target is not the selected visible Chrome window' }
  $root=[System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue=[Collections.Generic.Queue[object]]::new()
  $queue.Enqueue(@{element=$root;parent=$null;depth=0})
  $rows=[Collections.Generic.List[object]]::new()
  $timer=[Diagnostics.Stopwatch]::StartNew();$partial=$false;$omittedDocuments=0
  while($queue.Count -gt 0) {
    if($rows.Count -ge 400 -or $timer.ElapsedMilliseconds -ge 3000){$partial=$true;break}
    $entry=$queue.Dequeue();$element=$entry.element;$state=$element.Current
    # Page text, form values and DevTools output are not collected by default:
    # a native snapshot of browser chrome must not quietly become a read of
    # whatever page happens to be in front. IncludeDocuments is opt-in and only
    # for maintenance surfaces, where the question is whether a control exists.
    if(-not $IncludeDocuments -and $state.ControlType -eq [System.Windows.Automation.ControlType]::Document){$omittedDocuments++;continue}
    if($state.IsOffscreen){continue}
    $id=($element.GetRuntimeId() -join '.')
    $patterns=@($element.GetSupportedPatterns() | ForEach-Object {$_.ProgrammaticName})
    # A supported pattern is not evidence of its current state. Providers can
    # disappear during observation: retain the control and report unknown.
    $controlState=@{}
    foreach($spec in @(
      @{key='expandCollapse';type=[System.Windows.Automation.ExpandCollapsePattern];property='ExpandCollapseState'},
      @{key='toggle';type=[System.Windows.Automation.TogglePattern];property='ToggleState'},
      @{key='selected';type=[System.Windows.Automation.SelectionItemPattern];property='IsSelected'}
    )) {
      $patternId=$spec.type::Pattern
      if($patterns -contains $patternId.ProgrammaticName){
        try {
          $pattern=$element.GetCurrentPattern($patternId)
          $value=$pattern.Current.($spec.property)
          if($spec.key -eq 'selected'){$controlState[$spec.key]=[bool]$value}
          else{$controlState[$spec.key]=[string]$value}
        } catch {$controlState[$spec.key]='unknown'}
      }
    }
    $rows.Add(@{ref=$id;parent=$entry.parent;name=([string]$state.Name).Substring(0,[Math]::Min(300,([string]$state.Name).Length));automationId=$state.AutomationId;role=$state.ControlType.ProgrammaticName;enabled=$state.IsEnabled;patterns=$patterns;state=$controlState})
    if($entry.depth -ge 32){$partial=$true;continue}
    $child=$walker.GetFirstChild($element)
    while($child){
      if($queue.Count -ge 800 -or $timer.ElapsedMilliseconds -ge 3000){$partial=$true;break}
      $queue.Enqueue(@{element=$child;parent=$id;depth=($entry.depth+1)})
      $child=$walker.GetNextSibling($child)
    }
  }
  @{status='success';dispatched=$false;processId=$ChromeProcessId;windowHandle=$ChromeWindowHandle;observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();scope=($(if($IncludeDocuments){'native Chrome controls plus document subtrees; opt-in maintenance read'}else{'native Chrome controls only; document subtrees excluded; detached popup windows not included'}));partial=$partial;omittedDocuments=$omittedDocuments;controls=@($rows.ToArray())} | ConvertTo-Json -Depth 8 -Compress
} catch {
  @{status='failed';reason='native_snapshot_unavailable';dispatched=$false;retryable=$true} | ConvertTo-Json -Compress
}
