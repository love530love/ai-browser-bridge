param(
  [Parameter(Mandatory)][int]$ChromeProcessId,
  [Parameter(Mandatory)][long]$ChromeWindowHandle,
  [Parameter(Mandatory)][string]$Ref,
  [Parameter(Mandatory)][ValidateSet('expand', 'collapse', 'invoke')][string]$Action,
  [string]$ExpectName = '',
  [string]$ExpectRole = '',
  [string]$ExpectAutomationId = '',
  [ValidateSet('', 'control_gone')][string]$ExpectAfterInvoke = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeActionWindow {
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
'@
function Emit($payload) {
  $row = @{ processId = $ChromeProcessId; windowHandle = $ChromeWindowHandle; action = $Action; ref = $Ref }
  foreach ($key in $payload.Keys) { $row[$key] = $payload[$key] }
  $row | ConvertTo-Json -Depth 6 -Compress
  exit 0
}
try {
  $handle = [intptr]$ChromeWindowHandle
  [uint32]$owner = 0
  $null = [NativeActionWindow]::GetWindowThreadProcessId($handle, [ref]$owner)
  $process = Get-Process -Id $ChromeProcessId -ErrorAction Stop
  if ($owner -ne $ChromeProcessId -or $process.ProcessName -ne 'chrome' -or [IO.Path]::GetFileName($process.Path) -ine 'chrome.exe' -or -not [NativeActionWindow]::IsWindowVisible($handle)) {
    Emit @{ status = 'not_dispatched'; reason = 'native_target_not_verified'; dispatched = $false; retryable = $false }
  }

  # The walk deliberately mirrors native-ui-snapshot.ps1: same walker, same
  # document/offscreen exclusions, same 400-row and 3000ms budget, same depth
  # cap. A ref only resolves if the same traversal that produced it runs again,
  # so a control that was visible in the snapshot cannot be missed here because
  # of a different budget.
  #
  # It is a function because invoke needs a second walk after dispatch, and a
  # post-check with different exclusions would not be evidence about the same
  # tree. Pass TargetRef '' to count identity matches instead of resolving a ref.
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  function Scan-Tree([string]$TargetRef, [string]$IdentityName, [string]$IdentityRole, [string]$IdentityAutomationId) {
    $queue = [Collections.Generic.Queue[object]]::new()
    $queue.Enqueue(@{ element = $root; depth = 0 })
    $byRef = $null
    $identityMatches = 0
    $visited = 0
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($queue.Count -gt 0) {
      if ($visited -ge 400 -or $timer.ElapsedMilliseconds -ge 3000) { break }
      $entry = $queue.Dequeue()
      $element = $entry.element
      $current = $element.Current
      if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Document) { continue }
      if ($current.IsOffscreen) { continue }
      $visited++
      if ($TargetRef -ne '' -and ($element.GetRuntimeId() -join '.') -eq $TargetRef) { $byRef = $element; break }
      if ($IdentityName -ne '' -and [string]$current.Name -eq $IdentityName -and $current.ControlType.ProgrammaticName -eq $IdentityRole -and [string]$current.AutomationId -eq $IdentityAutomationId) { $identityMatches++ }
      if ($entry.depth -ge 32) { continue }
      $child = $walker.GetFirstChild($element)
      while ($child) {
        if ($queue.Count -ge 800 -or $timer.ElapsedMilliseconds -ge 3000) { break }
        $queue.Enqueue(@{ element = $child; depth = ($entry.depth + 1) })
        $child = $walker.GetNextSibling($child)
      }
    }
    return @{ element = $byRef; identityMatches = $identityMatches; scanned = $visited }
  }

  $scan = Scan-Tree $Ref '' '' ''
  $found = $scan.element
  if ($null -eq $found) {
    Emit @{ status = 'not_dispatched'; reason = 'native_control_not_found'; dispatched = $false; retryable = $true; scanned = $scan.scanned
      message = 'No visible native control currently has this runtime ref. Take a new snapshot; the window may have changed since the ref was issued. Nothing was dispatched.' }
  }

  $fullName = [string]$found.Current.Name
  $observed = @{
    name = $fullName.Substring(0, [Math]::Min(300, $fullName.Length))
    role = $found.Current.ControlType.ProgrammaticName
    automationId = [string]$found.Current.AutomationId
    enabled = $found.Current.IsEnabled
  }
  # The caller must repeat at least one identity attribute it read from the
  # snapshot. A runtime ref alone is not proof of identity: ids can be reused by
  # a different control after the tree is rebuilt.
  $mismatched = @()
  if ($ExpectName -ne '' -and $observed.name -ne $ExpectName) { $mismatched += 'name' }
  if ($ExpectRole -ne '' -and $observed.role -ne $ExpectRole) { $mismatched += 'role' }
  if ($ExpectAutomationId -ne '' -and $observed.automationId -ne $ExpectAutomationId) { $mismatched += 'automationId' }
  if ($mismatched.Count -gt 0) {
    Emit @{ status = 'not_dispatched'; reason = 'native_control_identity_mismatch'; dispatched = $false; retryable = $false
      mismatched = $mismatched; observed = $observed
      message = 'The control at this ref is not the control the caller described. Take a new snapshot and bind the current ref. Nothing was dispatched.' }
  }
  $patterns = @($found.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })

  # --- invoke: choose a menu item -------------------------------------------
  # Unlike expand/collapse this is NOT idempotent: choosing the same item twice
  # runs its command twice. So it is only offered together with a declared
  # post-condition, and the only one this layer can actually observe is that the
  # chosen item left the tree (which is what closing a menu does). "The pattern
  # call returned" is not evidence that a command ran, so it can never be the
  # success criterion on its own.
  if ($Action -eq 'invoke') {
    if ($ExpectAfterInvoke -eq '') {
      Emit @{ status = 'not_dispatched'; reason = 'native_post_condition_required'; dispatched = $false; retryable = $false
        message = 'invoke requires a declared post-condition. Without one there is nothing to compare the dispatch against, and a successful pattern call is not evidence the command ran.' }
    }
    $invokePatternId = [System.Windows.Automation.InvokePattern]::Pattern
    if ($patterns -notcontains $invokePatternId.ProgrammaticName) {
      Emit @{ status = 'not_dispatched'; reason = 'native_pattern_not_supported'; dispatched = $false; retryable = $false
        patterns = $patterns; observed = $observed
        message = 'This control does not support InvokePattern, so no invoke was attempted. Menu items support it; plain labels and containers do not.' }
    }
    if (-not $found.Current.IsEnabled) {
      Emit @{ status = 'not_dispatched'; reason = 'native_control_disabled'; dispatched = $false; retryable = $true
        observed = $observed
        message = 'The control is disabled. Invoking it would do nothing, and reporting that as an uncertain outcome would invite a pointless retry.' }
    }
    try {
      $invokePattern = $found.GetCurrentPattern($invokePatternId)
      $invokePattern.Invoke()
    } catch {
      # The call raised, so whether the provider started the command is unknown.
      Emit @{ status = 'uncertain'; dispatched = $null; verified = $false; reason = 'native_invoke_dispatch_threw'
        postCondition = $ExpectAfterInvoke; observed = $observed
        error = ([string]$_.Exception.Message).Substring(0, [Math]::Min(200, ([string]$_.Exception.Message).Length))
        message = 'The invoke call raised. Do not invoke again: the command may already be running. Take a new snapshot and inspect the window.' }
    }
    # Menus animate and the tree is rebuilt as they close, so a single miss is
    # not proof of absence. Require the identity to be absent from two
    # consecutive walks before calling the post-condition observed - otherwise a
    # re-render that hands out new runtime ids would look like "the item went
    # away" while the menu is still open.
    $settle = [Diagnostics.Stopwatch]::StartNew()
    $absentStreak = 0
    $lastScan = $null
    $gone = $false
    while ($settle.ElapsedMilliseconds -lt 2500) {
      $lastScan = Scan-Tree '' $fullName $observed.role $observed.automationId
      if ($lastScan.identityMatches -eq 0) {
        $absentStreak++
        if ($absentStreak -ge 2) { $gone = $true; break }
      } else { $absentStreak = 0 }
      Start-Sleep -Milliseconds 150
    }
    if ($gone) {
      Emit @{ status = 'success'; dispatched = $true; verified = $true; controlGone = $true
        postCondition = $ExpectAfterInvoke; settleMs = $settle.ElapsedMilliseconds; observed = $observed
        message = 'The invoke call returned and the control is no longer present in the window, which is the post-condition the caller declared. This proves the item was chosen; it does not prove the command it runs succeeded.' }
    }
    Emit @{ status = 'uncertain'; dispatched = $true; verified = $false; reason = 'native_invoke_effect_unobserved'
      controlGone = $false; postCondition = $ExpectAfterInvoke; settleMs = $settle.ElapsedMilliseconds
      observed = $observed; scanned = $lastScan.scanned
      message = 'The invoke call returned but the control is still in the tree, so the declared post-condition was not observed. Do not invoke again: running the same command twice is not recoverable by retrying. Inspect the window first.' }
  }

  # --- expand / collapse -----------------------------------------------------
  $patternId = [System.Windows.Automation.ExpandCollapsePattern]::Pattern
  if ($patterns -notcontains $patternId.ProgrammaticName) {
    Emit @{ status = 'not_dispatched'; reason = 'native_pattern_not_supported'; dispatched = $false; retryable = $false
      patterns = $patterns; observed = $observed
      message = 'This control does not support ExpandCollapsePattern, so no expand or collapse was attempted.' }
  }

  try {
    $pattern = $found.GetCurrentPattern($patternId)
    $before = [string]$pattern.Current.ExpandCollapseState
  } catch {
    Emit @{ status = 'not_dispatched'; reason = 'native_state_unreadable_before'; dispatched = $false; retryable = $true; observed = $observed
      message = 'The current expand/collapse state could not be read, so nothing was dispatched. An action whose effect cannot be compared against a prior state is not verifiable.' }
  }
  $wantExpanded = $Action -eq 'expand'
  $expandedStates = @('Expanded', 'PartiallyExpanded')
  if ($before -eq 'LeafNode') {
    Emit @{ status = 'not_dispatched'; reason = 'native_control_is_leaf_node'; dispatched = $false; retryable = $false
      stateBefore = $before; observed = $observed
      message = 'The control reports LeafNode: it has no expandable content, so expand/collapse cannot change it.' }
  }
  # Idempotent by construction. This is the property that makes a retry safe,
  # and the reason Toggle is not exposed: a repeated toggle inverts the effect.
  $alreadyInState = if ($wantExpanded) { $expandedStates -contains $before } else { $before -eq 'Collapsed' }
  if ($alreadyInState) {
    Emit @{ status = 'success'; dispatched = $false; verified = $true; alreadyInState = $true
      stateBefore = $before; stateAfter = $before; observed = $observed
      message = 'The control was already in the requested state, so nothing was dispatched.' }
  }

  try {
    if ($wantExpanded) { $pattern.Expand() } else { $pattern.Collapse() }
  } catch {
    # The call raised, so whether the provider applied it is unknowable here.
    Emit @{ status = 'uncertain'; dispatched = $null; verified = $false; reason = 'native_action_dispatch_threw'
      stateBefore = $before; observed = $observed; error = ([string]$_.Exception.Message).Substring(0, [Math]::Min(200, ([string]$_.Exception.Message).Length))
      message = 'The expand/collapse call raised. Take a new snapshot to read the real state before doing anything else; do not repeat blindly.' }
  }

  # Menus animate. Poll for a bounded window instead of reading once and
  # declaring failure while the provider is still catching up.
  $after = $null
  $settle = [Diagnostics.Stopwatch]::StartNew()
  while ($settle.ElapsedMilliseconds -lt 1500) {
    Start-Sleep -Milliseconds 150
    try {
      $reread = $found.GetCurrentPattern($patternId)
      $after = [string]$reread.Current.ExpandCollapseState
    } catch {
      $after = $null
    }
    if ($null -eq $after) { continue }
    if ($wantExpanded) { if ($expandedStates -contains $after) { break } } else { if ($after -eq 'Collapsed') { break } }
  }
  if ($null -eq $after) {
    Emit @{ status = 'uncertain'; dispatched = $true; verified = $false; reason = 'native_state_unreadable_after_dispatch'
      stateBefore = $before; observed = $observed
      message = 'The action was dispatched but the resulting state could not be read back. Take a new snapshot; do not repeat.' }
  }
  $reached = if ($wantExpanded) { $expandedStates -contains $after } else { $after -eq 'Collapsed' }
  if ($reached) {
    Emit @{ status = 'success'; dispatched = $true; verified = $true; alreadyInState = $false
      stateBefore = $before; stateAfter = $after; observed = $observed; settleMs = $settle.ElapsedMilliseconds
      message = 'The state changed to the requested value and was read back from the control itself.' }
  }
  Emit @{ status = 'failed'; dispatched = $true; verified = $false; reason = 'native_state_not_reached'
    stateBefore = $before; stateAfter = $after; observed = $observed; settleMs = $settle.ElapsedMilliseconds
    message = 'The pattern call returned without raising, but the state did not become the requested one. Do not repeat blindly: read a new snapshot first.' }
} catch {
  @{ status = 'failed'; reason = 'native_action_unavailable'; dispatched = $false; retryable = $true
     processId = $ChromeProcessId; windowHandle = $ChromeWindowHandle } | ConvertTo-Json -Compress
}
