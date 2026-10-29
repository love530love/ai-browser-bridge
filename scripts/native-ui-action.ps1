param(
  [Parameter(Mandatory)][int]$ChromeProcessId,
  [Parameter(Mandatory)][long]$ChromeWindowHandle,
  [Parameter(Mandatory)][string]$Ref,
  [Parameter(Mandatory)][ValidateSet('expand', 'collapse', 'invoke', 'toggle', 'select', 'value')][string]$Action,
  [string]$ExpectName = '',
  [string]$ExpectRole = '',
  [string]$ExpectAutomationId = '',
  [ValidateSet('', 'control_gone')][string]$ExpectAfterInvoke = '',
  # The requested state, not a command to flip something. This is what makes
  # toggle retry-safe: asking for the state a control is already in dispatches
  # nothing, exactly like expand and collapse.
  [ValidateSet('', 'on', 'off')][string]$DesiredState = '',
  [string]$ItemName = '',
  [string]$ValueText = '',
  # Page documents are skipped by default, so a ref can only ever resolve to
  # browser chrome. chrome:// pages are real UI though - their buttons live under
  # a Document node - and refusing to walk there made every control on
  # chrome://extensions unreachable while browser_native_snapshot could already
  # see it. Opting in changes only where a ref may resolve; nothing about the
  # page is returned unless the action itself reads it back.
  [switch]$IncludeDocuments
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
# Evidence is bounded on purpose: a text field can hold a document, and the
# reply travels over a socket that is read by a model. The caller compares the
# clipped value against what it asked for, so the clip is reported, never
# silently applied.
function Clip([string]$text, [int]$limit = 200) {
  if ($null -eq $text) { return '' }
  if ($text.Length -le $limit) { return $text }
  return $text.Substring(0, $limit)
}
function ClipNames($elements) {
  $names = @()
  foreach ($item in @($elements)) {
    if ($null -eq $item) { continue }
    $names += (Clip ([string]$item.Current.Name) 120)
    if ($names.Count -ge 8) { break }
  }
  return $names
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
      $isDocument = $current.ControlType -eq [System.Windows.Automation.ControlType]::Document
      if ($isDocument -and -not $IncludeDocuments) { continue }
      if ($current.IsOffscreen) { continue }
      if (-not $isDocument) { $visited++ }
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

  # --- toggle: a requested state, never a flip -------------------------------
  # TogglePattern was left out of the first version because a toggle dispatched
  # twice returns the control to where it started, so an uncertain result could
  # not be retried at all. That reasoning applies to a flip, not to a requested
  # state: reading the current state first makes this as idempotent as expand.
  # Indeterminate is refused rather than guessed, because one Toggle() from a
  # tri-state control may legally land on either side.
  if ($Action -eq 'toggle') {
    # No empty-DesiredState guard here: the adapter refuses a toggle without a
    # requested state before spawning anything, and a refusal that cannot echo
    # the request could not be validated. The check lives where it can be tested.
    $togglePatternId = [System.Windows.Automation.TogglePattern]::Pattern
    if ($patterns -notcontains $togglePatternId.ProgrammaticName) {
      Emit @{ status = 'not_dispatched'; reason = 'native_pattern_not_supported'; dispatched = $false; retryable = $false
        patterns = $patterns; observed = $observed; desiredState = $DesiredState
        message = 'This control does not support TogglePattern, so no toggle was attempted. Checkboxes and switches support it; menu items and links do not.' }
    }
    if (-not $found.Current.IsEnabled) {
      Emit @{ status = 'not_dispatched'; reason = 'native_control_disabled'; dispatched = $false; retryable = $true
        desiredState = $DesiredState; observed = $observed
        message = 'The control is disabled, so toggling it would change nothing. Nothing was dispatched.' }
    }
    $want = if ($DesiredState -eq 'on') { 'On' } else { 'Off' }
    try {
      $togglePattern = $found.GetCurrentPattern($togglePatternId)
      $toggleBefore = [string]$togglePattern.Current.ToggleState
    } catch {
      Emit @{ status = 'not_dispatched'; reason = 'native_state_unreadable_before'; dispatched = $false; retryable = $true
        desiredState = $DesiredState; observed = $observed
        message = 'The current toggle state could not be read, so nothing was dispatched. An action whose effect cannot be compared against a prior state is not verifiable.' }
    }
    if ($toggleBefore -eq 'Indeterminate') {
      Emit @{ status = 'not_dispatched'; reason = 'native_toggle_indeterminate'; dispatched = $false; retryable = $false
        desiredState = $DesiredState; toggleStateBefore = $toggleBefore; observed = $observed
        message = 'The control reports Indeterminate. One Toggle() from a tri-state control may land on either side, so the result would not be predictable and cannot be retried safely. Set the underlying option through its own control instead.' }
    }
    if ($toggleBefore -eq $want) {
      Emit @{ status = 'success'; dispatched = $false; verified = $true; alreadyInState = $true
        desiredState = $DesiredState; toggleStateBefore = $toggleBefore; toggleStateAfter = $toggleBefore; observed = $observed
        message = 'The control was already in the requested state, so nothing was dispatched.' }
    }
    try {
      $togglePattern.Toggle()
    } catch {
      Emit @{ status = 'uncertain'; dispatched = $null; verified = $false; reason = 'native_action_dispatch_threw'
        desiredState = $DesiredState; toggleStateBefore = $toggleBefore; observed = $observed
        error = (Clip ([string]$_.Exception.Message) 200)
        message = 'The toggle call raised. Read a new snapshot to see the real state before doing anything else; do not repeat blindly.' }
    }
    $toggleAfter = $null
    $toggleSettle = [Diagnostics.Stopwatch]::StartNew()
    while ($toggleSettle.ElapsedMilliseconds -lt 1500) {
      Start-Sleep -Milliseconds 120
      try { $toggleAfter = [string]$found.GetCurrentPattern($togglePatternId).Current.ToggleState } catch { $toggleAfter = $null }
      if ($toggleAfter -eq $want) { break }
    }
    if ($null -eq $toggleAfter) {
      Emit @{ status = 'uncertain'; dispatched = $true; verified = $false; reason = 'native_state_unreadable_after_dispatch'
        desiredState = $DesiredState; toggleStateBefore = $toggleBefore; observed = $observed
        message = 'The toggle was dispatched but the resulting state could not be read back. Take a new snapshot; do not repeat.' }
    }
    if ($toggleAfter -eq $want) {
      Emit @{ status = 'success'; dispatched = $true; verified = $true; alreadyInState = $false
        desiredState = $DesiredState; toggleStateBefore = $toggleBefore; toggleStateAfter = $toggleAfter
        observed = $observed; settleMs = $toggleSettle.ElapsedMilliseconds
        message = 'The toggle state changed to the requested value and was read back from the control itself.' }
    }
    Emit @{ status = 'failed'; dispatched = $true; verified = $false; reason = 'native_state_not_reached'
      desiredState = $DesiredState; toggleStateBefore = $toggleBefore; toggleStateAfter = $toggleAfter
      observed = $observed; settleMs = $toggleSettle.ElapsedMilliseconds
      message = 'The toggle call returned without raising, but the state did not become the requested one. Read a new snapshot before doing anything else.' }
  }

  # --- value: set text, then read it back ------------------------------------
  if ($Action -eq 'value') {
    $valuePatternId = [System.Windows.Automation.ValuePattern]::Pattern
    if ($patterns -notcontains $valuePatternId.ProgrammaticName) {
      Emit @{ status = 'not_dispatched'; reason = 'native_pattern_not_supported'; dispatched = $false; retryable = $false
        patterns = $patterns; observed = $observed; valueLength = $ValueText.Length
        message = 'This control does not support ValuePattern, so no value was set. Text fields, combo boxes and spinners support it; plain labels do not.' }
    }
    try {
      $valuePattern = $found.GetCurrentPattern($valuePatternId)
      if ($valuePattern.Current.IsReadOnly) {
        Emit @{ status = 'not_dispatched'; reason = 'native_control_read_only'; dispatched = $false; retryable = $false
          observed = $observed; valueLength = $ValueText.Length
          message = 'The control reports itself read-only, so setting a value would either be ignored or raise. Nothing was dispatched.' }
      }
      $valueBefore = [string]$valuePattern.Current.Value
    } catch {
      Emit @{ status = 'not_dispatched'; reason = 'native_state_unreadable_before'; dispatched = $false; retryable = $true
        observed = $observed; valueLength = $ValueText.Length
        message = 'The current value could not be read, so nothing was dispatched.' }
    }
    if ($valueBefore -ceq $ValueText) {
      Emit @{ status = 'success'; dispatched = $false; verified = $true; alreadyInState = $true
        valueBefore = (Clip $valueBefore); valueAfter = (Clip $valueBefore); valueLength = $ValueText.Length; valueMatches = $true; observed = $observed
        message = 'The control already held exactly this text, so nothing was dispatched.' }
    }
    try {
      $valuePattern.SetValue($ValueText)
    } catch {
      Emit @{ status = 'uncertain'; dispatched = $null; verified = $false; reason = 'native_action_dispatch_threw'
        valueBefore = (Clip $valueBefore); valueLength = $ValueText.Length; observed = $observed
        error = (Clip ([string]$_.Exception.Message) 200)
        message = 'The SetValue call raised. Read a new snapshot to see the real content before doing anything else; do not repeat blindly.' }
    }
    $valueAfter = $null
    $valueSettle = [Diagnostics.Stopwatch]::StartNew()
    while ($valueSettle.ElapsedMilliseconds -lt 1500) {
      Start-Sleep -Milliseconds 120
      try { $valueAfter = [string]$found.GetCurrentPattern($valuePatternId).Current.Value } catch { $valueAfter = $null }
      if ($valueAfter -ceq $ValueText) { break }
    }
    if ($null -eq $valueAfter) {
      Emit @{ status = 'uncertain'; dispatched = $true; verified = $false; reason = 'native_state_unreadable_after_dispatch'
        valueBefore = (Clip $valueBefore); valueLength = $ValueText.Length; observed = $observed
        message = 'The value was set but could not be read back. Take a new snapshot; do not repeat.' }
    }
    if ($valueAfter -ceq $ValueText) {
      Emit @{ status = 'success'; dispatched = $true; verified = $true; alreadyInState = $false
        valueBefore = (Clip $valueBefore); valueAfter = (Clip $valueAfter); valueLength = $ValueText.Length; valueMatches = $true
        observed = $observed; settleMs = $valueSettle.ElapsedMilliseconds
        message = 'The control now holds exactly the requested text, read back from the control itself.' }
    }
    Emit @{ status = 'failed'; dispatched = $true; verified = $false; reason = 'native_value_not_reached'
      valueBefore = (Clip $valueBefore); valueAfter = (Clip $valueAfter); valueLength = $ValueText.Length; valueMatches = $false
      observed = $observed; settleMs = $valueSettle.ElapsedMilliseconds
      message = 'The value was set without raising but reads back differently, so the control either normalised it or refused it. Read the returned valueAfter before deciding what to do; do not repeat the same call.' }
  }

  # --- select: choose one named item -----------------------------------------
  # Two shapes exist and both are handled, because Chrome uses both: the control
  # itself is the item (a radio button, a tab), or the control is a list that
  # contains the item. Success always means the selection was read back and the
  # requested name is in it.
  if ($Action -eq 'select') {
    # itemName is required by the adapter before spawn; see the note on toggle.
    $siPatternId = [System.Windows.Automation.SelectionItemPattern]::Pattern
    $selPatternId = [System.Windows.Automation.SelectionPattern]::Pattern
    $isItem = $patterns -contains $siPatternId.ProgrammaticName
    $isContainer = $patterns -contains $selPatternId.ProgrammaticName
    if (-not $isItem -and -not $isContainer) {
      Emit @{ status = 'not_dispatched'; reason = 'native_pattern_not_supported'; dispatched = $false; retryable = $false
        patterns = $patterns; observed = $observed; itemName = (Clip $ItemName 120)
        message = 'This control supports neither SelectionItemPattern nor SelectionPattern, so no selection was attempted. Radio buttons, tabs, list items and list boxes support one of them.' }
    }
    $target = $found
    if (-not $isItem) {
      # Bounded search inside the container. Same walker as everything else, so
      # an item that the snapshot could see is an item this can find.
      $queue = [Collections.Generic.Queue[object]]::new()
      $queue.Enqueue(@{ element = $found; depth = 0 })
      $visitTimer = [Diagnostics.Stopwatch]::StartNew()
      $visited = 0
      $target = $null
      while ($queue.Count -gt 0 -and $visited -lt 300 -and $visitTimer.ElapsedMilliseconds -lt 1500) {
        $entry = $queue.Dequeue()
        $element = $entry.element
        $visited++
        if ([string]$element.Current.Name -eq $ItemName -and $element.GetSupportedPatterns().ProgrammaticName -contains $siPatternId.ProgrammaticName) { $target = $element; break }
        if ($entry.depth -ge 16) { continue }
        $child = $walker.GetFirstChild($element)
        while ($child) {
          $queue.Enqueue(@{ element = $child; depth = ($entry.depth + 1) })
          $child = $walker.GetNextSibling($child)
        }
      }
      if ($null -eq $target) {
        Emit @{ status = 'not_dispatched'; reason = 'native_item_not_found'; dispatched = $false; retryable = $true
          itemName = (Clip $ItemName 120); observed = $observed; scanned = $visited
          message = 'No selectable child of this control currently carries that name. Take a new snapshot: the list may be collapsed, filtered or virtualised. Nothing was dispatched.' }
      }
    }
    try {
      $itemPattern = $target.GetCurrentPattern($siPatternId)
      $wasSelected = $itemPattern.Current.IsSelected
    } catch {
      Emit @{ status = 'not_dispatched'; reason = 'native_state_unreadable_before'; dispatched = $false; retryable = $true
        itemName = (Clip $ItemName 120); observed = $observed
        message = 'The current selection state could not be read, so nothing was dispatched.' }
    }
    if ($wasSelected) {
      # Selecting the item again is harmless for a single-select list, but
      # reporting it as a dispatch would be a lie, and for a multi-select list it
      # could toggle the item off. So: nothing is dispatched when it already holds.
      $selectionNow = @()
      if ($isContainer) {
        try { $selectionNow = ClipNames ($found.GetCurrentPattern($selPatternId).Current.GetSelection()) } catch { $selectionNow = @() }
      } else {
        $selectionNow = @(Clip $ItemName 120)
      }
      Emit @{ status = 'success'; dispatched = $false; verified = $true; alreadyInState = $true
        itemName = (Clip $ItemName 120); selectionBefore = $selectionNow; selectionAfter = $selectionNow; observed = $observed
        message = 'The item was already selected, so nothing was dispatched.' }
    }
    $selectionBefore = @()
    if ($isContainer) {
      try { $selectionBefore = ClipNames ($found.GetCurrentPattern($selPatternId).Current.GetSelection()) } catch { $selectionBefore = @() }
    }
    try {
      $itemPattern.Select()
    } catch {
      Emit @{ status = 'uncertain'; dispatched = $null; verified = $false; reason = 'native_action_dispatch_threw'
        itemName = (Clip $ItemName 120); selectionBefore = $selectionBefore; observed = $observed
        error = (Clip ([string]$_.Exception.Message) 200)
        message = 'The Select call raised. Read a new snapshot to see the real selection before doing anything else; do not repeat blindly.' }
    }
    $selectionAfter = @()
    $selectSettle = [Diagnostics.Stopwatch]::StartNew()
    while ($selectSettle.ElapsedMilliseconds -lt 1500) {
      Start-Sleep -Milliseconds 120
      if ($isContainer) {
        try { $selectionAfter = ClipNames ($found.GetCurrentPattern($selPatternId).Current.GetSelection()) } catch { $selectionAfter = @() }
      } else {
        try { if ($target.GetCurrentPattern($siPatternId).Current.IsSelected) { $selectionAfter = @(Clip $ItemName 120) } else { $selectionAfter = @() } } catch { $selectionAfter = @() }
      }
      if ($selectionAfter -contains (Clip $ItemName 120)) { break }
    }
    if ($selectionAfter -contains (Clip $ItemName 120)) {
      Emit @{ status = 'success'; dispatched = $true; verified = $true; alreadyInState = $false
        itemName = (Clip $ItemName 120); selectionBefore = $selectionBefore; selectionAfter = $selectionAfter
        observed = $observed; settleMs = $selectSettle.ElapsedMilliseconds
        message = 'The requested item is in the control read-back selection, so the selection took effect. This proves the item is selected, not that the page reacted to it.' }
    }
    Emit @{ status = 'failed'; dispatched = $true; verified = $false; reason = 'native_selection_not_reached'
      itemName = (Clip $ItemName 120); selectionBefore = $selectionBefore; selectionAfter = $selectionAfter
      observed = $observed; settleMs = $selectSettle.ElapsedMilliseconds
      message = 'The Select call returned without raising but the read-back selection does not contain the requested item. Read selectionAfter before deciding what to do; do not repeat the same call.' }
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
