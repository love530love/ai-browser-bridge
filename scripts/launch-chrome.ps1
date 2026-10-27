param(
  [string]$Url = '',
  [switch]$AsJson,
  [ValidateRange(1, 60)][int]$VerifyTimeoutSec = 20
)

# Launch the user's own Chrome when nothing is running, and never disturb it
# when something already is.
#
# Two rules make this safe to expose as a capability:
#
#   1. If any chrome process exists, nothing is launched. "Start the browser" is
#      only for the case where there is no browser; reusing the running instance
#      is always preferred, because a second instance means a second profile and
#      that means lost cookies and kicked accounts.
#
#   2. The command line carries no profile flags at all - no --user-data-dir, no
#      --profile-directory, no --incognito. Chrome therefore opens with the same
#      profile a human double-clicking the icon would get. Passing an explicit
#      profile directory would be worse than passing nothing: the bridge cannot
#      know which profile the user actually uses, and guessing produces the
#      logged-out session the whole session-reuse rule exists to avoid.

$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LaunchWindow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public static IntPtr[] VisibleWindowsForProcess(int targetProcessId) {
    var handles = new System.Collections.Generic.List<IntPtr>();
    EnumWindows((hWnd, lParam) => {
      uint processId;
      GetWindowThreadProcessId(hWnd, out processId);
      if ((targetProcessId == 0 || processId == (uint)targetProcessId) && IsWindowVisible(hWnd)) handles.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    return handles.ToArray();
  }
}
'@

function Write-Result($value) {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  if ($AsJson) { ConvertTo-Json -InputObject $value -Compress -Depth 6 } else { $value }
}

if ($Url -and $Url -notmatch '^https?://') {
  Write-Result ([pscustomobject]@{ status='denied'; reason='unsupported_url_scheme'; dispatched=$false; message='Only http(s) URLs can be opened at launch; nothing was launched.' })
  exit 0
}

# Rule 1: reuse beats creation. Any chrome process means the browser is already
# running, so launching would create a competing instance rather than help.
$running = @(Get-Process chrome -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  $windows = @()
  foreach ($process in $running) {
    foreach ($handle in [LaunchWindow]::VisibleWindowsForProcess($process.Id)) {
      $windows += [pscustomobject]@{ ProcessId = $process.Id; WindowHandle = $handle.ToInt64() }
    }
  }
  Write-Result ([pscustomobject]@{
    status = 'not_dispatched'
    reason = 'chrome_already_running'
    dispatched = $false
    processCount = $running.Count
    visibleWindowCount = $windows.Count
    windows = @($windows | Select-Object -First 8)
    message = 'Chrome is already running, so nothing was launched. Reuse it: open the page with browser_open instead.'
  })
  exit 0
}

# Resolve chrome.exe from the registered App Path first (this is what the shell
# uses when a human types "chrome"), then from the standard install locations.
$candidates = New-Object System.Collections.Generic.List[string]
foreach ($hive in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
                    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe')) {
  try {
    $entry = Get-ItemProperty -Path $hive -ErrorAction Stop
    $path = $entry.'(default)'
    if ($path) { $candidates.Add(($path -replace '^"|"$', '')) }
  } catch { }
}
foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
  if ($base) { $candidates.Add((Join-Path $base 'Google\Chrome\Application\chrome.exe')) }
}
$chromePath = $null
foreach ($candidate in $candidates) {
  if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $chromePath = (Resolve-Path -LiteralPath $candidate).Path; break }
}
if (-not $chromePath) {
  Write-Result ([pscustomobject]@{
    status = 'not_dispatched'
    reason = 'chrome_not_found'
    dispatched = $false
    searched = @($candidates | Where-Object { $_ } | Select-Object -First 8)
    message = 'No chrome.exe was found in the registered App Path or the standard install locations; nothing was launched.'
  })
  exit 0
}

# Rule 2: the argument list is deliberately minimal. A URL and nothing else.
$argumentList = @()
if ($Url) { $argumentList += $Url }
try {
  $process = Start-Process -FilePath $chromePath -ArgumentList $argumentList -PassThru
} catch {
  Write-Result ([pscustomobject]@{ status='failed'; reason='chrome_launch_failed'; dispatched=$false; message=$_.Exception.Message })
  exit 0
}

# A launched process is not the same as a usable browser. Wait for a visible
# window so the caller is not told "launched" when only a stub process exists.
$deadline = (Get-Date).AddSeconds($VerifyTimeoutSec)
$handle = [IntPtr]::Zero
do {
  Start-Sleep -Milliseconds 400
  $handles = [LaunchWindow]::VisibleWindowsForProcess($process.Id)
  if ($handles.Count -gt 0) { $handle = $handles[0]; break }
} while ((Get-Date) -lt $deadline)

if ($handle -eq [IntPtr]::Zero) {
  Write-Result ([pscustomobject]@{
    status = 'uncertain'
    reason = 'chrome_launched_without_visible_window'
    dispatched = $true
    verified = $false
    processId = $process.Id
    chromePath = $chromePath
    argumentList = @($argumentList)
    profileFlags = 'none'
    message = 'chrome.exe was started but no visible window appeared in time. Inspect before launching again; a second launch would open another window.'
  })
  exit 0
}

Write-Result ([pscustomobject]@{
  status = 'success'
  reason = 'chrome_launched'
  dispatched = $true
  verified = $true
  processId = $process.Id
  windowHandle = $handle.ToInt64()
  chromePath = $chromePath
  argumentList = @($argumentList)
  profileFlags = 'none'
  message = 'Chrome started with the default user profile (no profile or incognito flags), so existing cookies and logins apply.'
})
exit 0
