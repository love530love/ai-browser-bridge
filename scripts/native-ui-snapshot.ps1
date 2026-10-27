param([Parameter(Mandatory)][int]$ChromeProcessId, [Parameter(Mandatory)][long]$ChromeWindowHandle)
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
    # Do not collect page text, form values, or DevTools output. Browser chrome
    # and native menu controls are the scope of this particular snapshot.
    if($state.ControlType -eq [System.Windows.Automation.ControlType]::Document){$omittedDocuments++;continue}
    if($state.IsOffscreen){continue}
    $id=($element.GetRuntimeId() -join '.')
    $patterns=@($element.GetSupportedPatterns() | ForEach-Object {$_.ProgrammaticName})
    $rows.Add(@{ref=$id;parent=$entry.parent;name=([string]$state.Name).Substring(0,[Math]::Min(300,([string]$state.Name).Length));automationId=$state.AutomationId;role=$state.ControlType.ProgrammaticName;enabled=$state.IsEnabled;patterns=$patterns})
    if($entry.depth -ge 32){$partial=$true;continue}
    $child=$walker.GetFirstChild($element)
    while($child){
      if($queue.Count -ge 800 -or $timer.ElapsedMilliseconds -ge 3000){$partial=$true;break}
      $queue.Enqueue(@{element=$child;parent=$id;depth=($entry.depth+1)})
      $child=$walker.GetNextSibling($child)
    }
  }
  @{status='success';dispatched=$false;processId=$ChromeProcessId;windowHandle=$ChromeWindowHandle;observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();scope='native Chrome controls only; document subtrees excluded; detached popup windows not included';partial=$partial;omittedDocuments=$omittedDocuments;controls=@($rows.ToArray())} | ConvertTo-Json -Depth 8 -Compress
} catch {
  @{status='failed';reason='native_snapshot_unavailable';dispatched=$false;retryable=$true} | ConvertTo-Json -Compress
}
