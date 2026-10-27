param(
  [Parameter(Mandatory)][ValidateSet('reveal', 'read')][string]$Action,
  [string]$Site,
  [string]$AltSites,
  [string]$ExpectedOrigin,
  [int]$ChromeProcessId = 0,
  [long]$ChromeWindowHandle = 0,
  [switch]$CloseTab,
  [int]$WaitMs = 9000
)
# Drives Chrome's own password manager through Windows UI Automation.
#
# Why UI Automation and not CDP: an extension cannot attach a debugger to a
# chrome:// page (Chrome answers "Cannot access a chrome:// URL"), cannot inject
# a content script there, and cannot request chrome.passwordsPrivate, which is
# restricted to component extensions. The plaintext is also not in the page DOM:
# the WebUI holds masks and asks the browser process for the value on reveal. So
# the only route to a saved password from outside Chrome is the same one a
# person uses - the real UI.
#
# Boundaries this script enforces rather than promises:
#   - one site per call, and the site must match the entry name exactly, not as
#     a substring, because a substring match is how a lookalike site gets fed;
#   - the details pane must show the same site before any value is read, so two
#     independent bindings have to agree;
#   - the tab is opened with Alt+Enter so the user's current page is never
#     navigated away, and it is only closed when -CloseTab is passed and the
#     address bar still shows the password manager;
#   - an authentication prompt is reported, never worked around. If the field is
#     still masked after the reveal and the foreground left Chrome, the caller
#     gets waiting_for_user_auth and the user completes it.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PmUiWindow {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
 public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
}
'@
$targetUrl = 'chrome://password-manager/passwords'

function Result([hashtable]$fields) {
  $base = @{ dispatched = $false; retryable = $false; action = $Action }
  foreach ($key in $fields.Keys) { $base[$key] = $fields[$key] }
  $base | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

function Fail([string]$reason, [hashtable]$extra = @{}) {
  $fields = @{ status = 'failed'; reason = $reason }
  foreach ($key in $extra.Keys) { $fields[$key] = $extra[$key] }
  Result $fields
}

function Get-VisibleChromeWindows {
  $found = [Collections.Generic.List[object]]::new()
  $callback = [PmUiWindow+EnumWindowsProc]{
    param([IntPtr]$h, [IntPtr]$p)
    if (-not [PmUiWindow]::IsWindowVisible($h)) { return $true }
    [uint32]$owner = 0
    $null = [PmUiWindow]::GetWindowThreadProcessId($h, [ref]$owner)
    if ($owner -le 0) { return $true }
    try {
      $proc = Get-Process -Id $owner -ErrorAction Stop
      if ($proc.ProcessName -eq 'chrome' -and [IO.Path]::GetFileName($proc.Path) -ieq 'chrome.exe') {
        $found.Add(@{ processId = [int]$owner; windowHandle = [int64]$h })
      }
    } catch { }
    return $true
  }
  $null = [PmUiWindow]::EnumWindows($callback, [IntPtr]::Zero)
  return $found
}

# --- resolve and verify the target window -----------------------------------
$handle = [intptr]$ChromeWindowHandle
if ($ChromeWindowHandle -gt 0) {
  [uint32]$owner = 0
  $null = [PmUiWindow]::GetWindowThreadProcessId($handle, [ref]$owner)
  if ($ChromeProcessId -gt 0 -and $owner -ne $ChromeProcessId) { Fail 'window_owner_mismatch' @{ status = 'denied' } }
  if (-not [PmUiWindow]::IsWindowVisible($handle)) { Fail 'window_not_visible' @{ status = 'denied' } }
  $ChromeProcessId = [int]$owner
} else {
  $windows = Get-VisibleChromeWindows
  if ($windows.Count -eq 0) { Fail 'no_visible_chrome_window' @{ status = 'not_dispatched' } }
  if ($windows.Count -gt 1) {
    Result @{ status = 'denied'; reason = 'chrome_target_ambiguous'; candidates = @($windows) }
  }
  $ChromeProcessId = $windows[0].processId
  $handle = [intptr]$windows[0].windowHandle
}
try {
  $proc = Get-Process -Id $ChromeProcessId -ErrorAction Stop
  if ($proc.ProcessName -ne 'chrome' -or [IO.Path]::GetFileName($proc.Path) -ine 'chrome.exe') { Fail 'not_a_chrome_process' @{ status = 'denied' } }
} catch { Fail 'chrome_process_missing' @{ status = 'denied' } }

$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
if (-not $root) { Fail 'window_automation_unavailable' }

function Find-ById([string]$id) {
  $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}
function Find-AllById([string]$id) {
  $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
  return @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition))
}
function Get-Value($element) {
  try { return [string]$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { return $null }
}
function Get-AddressBarValue {
  $edit = Find-ById 'view_1012'
  if (-not $edit) { return '' }
  $value = Get-Value $edit
  if ($value) { return $value }
  return ''
}
function Test-Masked([string]$value) {
  if (-not $value) { return $false }
  return ($value -match '^[\u2022\u25CF\*]+$')
}

# The details pane has two Edit controls whose automation id is "input": the
# username and the password. Layout order is not a contract, so bind the password
# field to the Text node labelled "Password" that precedes it, and only fall back
# to vertical order when that binding is unavailable.
function Get-PasswordField {
  $edits = @(Find-AllById 'input' | Where-Object { -not $_.Current.IsOffscreen })
  if ($edits.Count -eq 0) { return $null }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  foreach ($edit in $edits) {
    $node = $walker.GetPreviousSibling($edit)
    for ($i = 0; $i -lt 3 -and $node; $i++) {
      try {
        if ($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and [string]$node.Current.Name -match '^(Password|密码)$') { return $edit }
      } catch { }
      $node = $walker.GetPreviousSibling($node)
    }
  }
  if ($edits.Count -ge 2) { return ($edits | Sort-Object { $_.Current.BoundingRectangle.Top })[-1] }
  return $edits[0]
}
function Get-UsernameField {
  $edits = @(Find-AllById 'input' | Where-Object { -not $_.Current.IsOffscreen })
  $password = Get-PasswordField
  foreach ($edit in $edits) { if ($edit -ne $password) { return $edit } }
  return $null
}

# --- read an already-open details pane --------------------------------------
function Read-Details([string]$expectedSite) {
  $title = Find-ById 'title'
  $shownSite = if ($title) { [string]$title.Current.Name } else { '' }
  $passwordField = Get-PasswordField
  if (-not $passwordField) { return @{ ok = $false; reason = 'password_field_not_found'; shownSite = $shownSite } }
  $password = Get-Value $passwordField
  $usernameField = Get-UsernameField
  $username = if ($usernameField) { Get-Value $usernameField } else { '' }
  $originLink = ''
  $linkCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Hyperlink)
  foreach ($link in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $linkCondition)) {
    $value = Get-Value $link
    if ($value -and $value -match '^https?://') { $originLink = $value; break }
  }
  # Two independent bindings have to agree before any value is returned: the
  # entry name the caller asked for, and the origin the details pane shows.
  # Chrome names an entry after the site, which can be broader than the origin,
  # so the origin check is the one that actually stops a lookalike host. The pane
  # shows the exact page the credential was saved on, path included, so the
  # comparison is on scheme+host+port, never on the whole URL.
  $originMatches = $null
  if ($ExpectedOrigin -and $originLink) {
    try {
      $linkOrigin = ([Uri]$originLink).GetLeftPart([UriPartial]::Authority)
      $wantOrigin = ([Uri]$ExpectedOrigin).GetLeftPart([UriPartial]::Authority)
      $originMatches = ($linkOrigin -eq $wantOrigin)
    } catch { $originMatches = $false }
  }
  $originAuthority = $null
  if ($originLink) { try { $originAuthority = ([Uri]$originLink).GetLeftPart([UriPartial]::Authority) } catch { } }
  return @{
    ok              = $true
    shownSite       = $shownSite
    originLink      = $originLink
    originAuthority = $originAuthority
    originMatches   = $originMatches
    username        = $username
    password        = $password
    passwordMasked  = (Test-Masked $password)
    siteMatches     = ($expectedSite -eq '' -or $shownSite -eq $expectedSite -or $shownSite -eq ($expectedSite -replace '^https?://', ''))
  }
}

if ($Action -eq 'read') {
  if (-not $Site) { Fail 'site_required_for_read' @{ status = 'denied' } }
  $details = Read-Details $Site
  if (-not $details.ok) { Result @{ status = 'uncertain'; reason = $details.reason; shownSite = $details.shownSite } }
  if (-not $details.siteMatches) { Result @{ status = 'denied'; reason = 'site_binding_mismatch'; shownSite = $details.shownSite } }
  if ($details.originMatches -eq $false) { Result @{ status = 'denied'; reason = 'origin_binding_mismatch'; shownSite = $details.shownSite; origin = $details.originAuthority; loginUrl = $details.originLink } }
  Result @{
    status           = 'success'
    site             = $details.shownSite
    origin           = $details.originAuthority
    loginUrl         = $details.originLink
    username         = $details.username
    password         = $details.password
    requiresUserAuth = $false
    evidence         = @{ method = 'windows_ui_automation'; passwordMasked = $details.passwordMasked }
  }
}

# --- reveal: open the page, search, open details, click show ----------------
if (-not $Site) { Fail 'site_required' @{ status = 'denied' } }

$focused = [PmUiWindow]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 250
if (-not $focused -or [PmUiWindow]::GetForegroundWindow() -ne $handle) {
  Result @{ status = 'not_dispatched'; reason = 'window_not_foreground'; note = 'The selected Chrome window is not foreground, so no keystroke was sent.' }
}
$shell = New-Object -ComObject WScript.Shell
$shell.SendKeys('^l'); Start-Sleep -Milliseconds 180
$shell.SendKeys($targetUrl); Start-Sleep -Milliseconds 180
$shell.SendKeys('%{ENTER}')

# Wait for the page itself, not for a timer: the Document's name is the page title.
$deadline = (Get-Date).AddMilliseconds($WaitMs)
$pageReady = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 300
  $address = Get-AddressBarValue
  $docCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
  foreach ($doc in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $docCondition)) {
    if ([string]$doc.Current.Name -match 'Password Manager') { $pageReady = $true; break }
  }
  if ($pageReady -and $address -like "$targetUrl*") { break }
}
if (-not $pageReady) { Result @{ status = 'uncertain'; reason = 'password_manager_page_not_observed'; dispatched = $true } }

# The entry list loads asynchronously after the page appears, so wait for it to
# actually render rather than sleeping a fixed amount and hoping.
$entryCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'seePasswordDetails')
$listDeadline = (Get-Date).AddMilliseconds($WaitMs)
$listRendered = $false
while ((Get-Date) -lt $listDeadline) {
  $search = Find-ById 'searchInput'
  if ($search) {
    $probeEntries = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $entryCondition))
    $listNode = Find-ById 'passwords'
    if ($probeEntries.Count -gt 0 -or $listNode) { $listRendered = $true; break }
  }
  Start-Sleep -Milliseconds 250
}
$search = Find-ById 'searchInput'
if (-not $search) { Result @{ status = 'uncertain'; reason = 'search_input_not_found'; dispatched = $true } }

# Chrome names an entry after the site string it was saved with, which is not
# always the bare host: an IP-based login is stored as "http://host:port". Both
# spellings are tried, but each one still has to match an entry name exactly.
$candidates = @(@($Site) + @($AltSites -split ',' | ForEach-Object { $_.Trim() }) | Where-Object { $_ } | Select-Object -Unique)
$matchedSite = ''
$matchedEntry = $null
$visibleNames = @()
foreach ($candidate in $candidates) {
  $search.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($candidate)
  # Give the filter a chance to settle: the list re-renders on every keystroke of
  # a real user, and a value set programmatically still goes through the same
  # input pipeline, just without the keystroke pacing. Stop as soon as the exact
  # entry appears, or once the visible set has stopped changing for two polls.
  $filterDeadline = (Get-Date).AddSeconds(6)
  $entries = @()
  $previousSignature = ''
  $stablePolls = 0
  while ((Get-Date) -lt $filterDeadline) {
    Start-Sleep -Milliseconds 300
    $entries = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $entryCondition) | Where-Object { -not $_.Current.IsOffscreen })
    $exactNow = @($entries | Where-Object { [string]$_.Current.Name -eq "$candidate, see details" })
    if ($exactNow.Count -ge 1) { $matchedEntry = $exactNow[0]; break }
    $signature = (@($entries | ForEach-Object { [string]$_.Current.Name }) -join '|')
    if ($signature -eq $previousSignature) { $stablePolls += 1; if ($stablePolls -ge 2) { break } }
    else { $stablePolls = 0; $previousSignature = $signature }
  }
  $visibleNames = @($entries | ForEach-Object { ([string]$_.Current.Name -replace ', see details$', '') })
  if ($matchedEntry) { $matchedSite = $candidate; break }
}
if (-not $matchedEntry) {
  Result @{
    status         = 'not_found'
    reason         = 'no_exact_entry'
    site           = $Site
    dispatched     = $true
    triedSites     = $candidates
    visibleEntries = $visibleNames
    note           = 'Only an exact name match is accepted; a similar name is not the same site and must never be revealed. Retry with one of visibleEntries if that is the same login.'
  }
}
$matchedEntry.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Start-Sleep -Milliseconds 1400

$details = Read-Details $matchedSite
if (-not $details.ok) { Result @{ status = 'uncertain'; reason = $details.reason; dispatched = $true } }
if (-not $details.siteMatches) {
  Result @{ status = 'denied'; reason = 'site_binding_mismatch'; shownSite = $details.shownSite; dispatched = $true }
}
if ($details.originMatches -eq $false) {
  Result @{ status = 'denied'; reason = 'origin_binding_mismatch'; shownSite = $details.shownSite; origin = $details.originLink; dispatched = $true }
}

$revealButton = Find-ById 'showPasswordButton'
if (-not $revealButton) { Result @{ status = 'uncertain'; reason = 'reveal_control_not_found'; dispatched = $true; shownSite = $details.shownSite } }

if (-not $details.passwordMasked) {
  # Already revealed (a previous call, or a session where Chrome kept it open).
  $payload = @{
    status = 'success'; site = $details.shownSite; origin = $details.originAuthority; loginUrl = $details.originLink
    username = $details.username; password = $details.password; requiresUserAuth = $false
    evidence = @{ method = 'windows_ui_automation'; revealInvoked = $false; alreadyRevealed = $true }
  }
} else {
  $revealButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Start-Sleep -Milliseconds 2000
  $after = Read-Details $matchedSite
  $foregroundNow = [PmUiWindow]::GetForegroundWindow()
  [uint32]$fgOwner = 0
  $null = [PmUiWindow]::GetWindowThreadProcessId($foregroundNow, [ref]$fgOwner)
  $leftChrome = ($foregroundNow -ne $handle)
  if ($after.ok -and -not $after.passwordMasked -and $after.password -and $after.originMatches -ne $false) {
    $payload = @{
      status = 'success'; site = $after.shownSite; origin = $after.originAuthority; loginUrl = $after.originLink
      username = $after.username; password = $after.password; requiresUserAuth = $false
      evidence = @{ method = 'windows_ui_automation'; revealInvoked = $true; alreadyRevealed = $false }
    }
  } elseif ($leftChrome) {
    # Chrome asked the operating system for consent. That is the user's step, not
    # ours: report it and leave the tab open so the caller can read it afterwards.
    $payload = @{
      status = 'waiting_for_user_auth'; reason = 'os_auth_prompt_observed'; dispatched = $true
      site = $details.shownSite; foregroundOwnerProcessId = [int]$fgOwner
      note = 'Chrome handed the reveal to an operating-system prompt. Ask the user to complete it, then call again with action:"read" to collect the value. Do not attempt to bypass the prompt.'
    }
  } else {
    $payload = @{
      status = 'uncertain'; reason = 'reveal_not_observed'; dispatched = $true
      site = $details.shownSite
      note = 'The reveal control was invoked and the foreground stayed in Chrome, but the field is still masked. Treat the outcome as unknown and inspect before acting again.'
    }
  }
}

if ($CloseTab -and $payload.status -eq 'success') {
  $address = Get-AddressBarValue
  if ($address -like "$targetUrl*") { $shell.SendKeys('^w'); Start-Sleep -Milliseconds 250; $payload.tabClosed = $true }
  else { $payload.tabClosed = $false; $payload.tabCloseSkipped = 'address_bar_no_longer_shows_the_password_manager' }
}
$payload | ConvertTo-Json -Depth 6 -Compress
