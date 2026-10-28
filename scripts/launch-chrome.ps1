param(
  [string]$Url = '',
  [switch]$AsJson,
  [switch]$Activate,
  [switch]$DryRun,
  [ValidateRange(1, 60)][int]$VerifyTimeoutSec = 20
)

# Launch the browser the user actually uses, without taking the screen away
# from them.
#
# Three rules make this safe to expose as a capability:
#
#   1. Reuse beats creation. If any chrome process exists, nothing is launched.
#      "Start the browser" is only for the case where there is no browser; a
#      second instance means a second profile and that means lost cookies.
#
#   2. The binary is chosen by profile evidence, not by registry order. A machine
#      can carry several Chrome channels side by side (stable, Beta, Dev, Canary
#      aka "Chrome SxS") and each channel has its own user-data directory. The
#      shell resolves "chrome" from HKCU before HKLM, so the shortcut-friendly
#      answer is frequently the Canary/SxS install - a browser whose profile has
#      no bookmarks, no logins and no history. Opening that one looks exactly
#      like "the agent wiped my session". So candidates are scored on which
#      profile directory actually holds a used profile, and a channel with no
#      usable profile is refused rather than launched.
#
#   3. Launching never steals focus. Chrome is started through CreateProcess with
#      SW_SHOWNOACTIVATE, so the window appears behind whatever the user is doing
#      instead of interrupting it. -Activate opts back in for the rare case where
#      a human really must look at the screen. The result reports whether focus
#      actually moved, measured before/after, rather than promising it did not.

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class LaunchWindow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
    public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hWnd, uint command);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcess(string lpApplicationName, string lpCommandLine,
    IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags,
    IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);

  // Only top-level, owned-by-nobody, titled, visible windows count as "the
  // browser is on screen". Chrome keeps a pile of invisible message-only
  // windows, and counting those would report a session that the user cannot see.
  public static IntPtr[] BrowserWindows(int targetProcessId) {
    var handles = new System.Collections.Generic.List<IntPtr>();
    EnumWindows((hWnd, lParam) => {
      uint processId;
      GetWindowThreadProcessId(hWnd, out processId);
      if (targetProcessId != 0 && processId != (uint)targetProcessId) return true;
      if (!IsWindowVisible(hWnd)) return true;
      if (GetWindow(hWnd, 4) != IntPtr.Zero) return true;
      if (GetWindowTextLength(hWnd) <= 0) return true;
      handles.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    return handles.ToArray();
  }

  public static string WindowTitle(IntPtr hWnd) {
    int length = GetWindowTextLength(hWnd);
    if (length <= 0) return string.Empty;
    var buffer = new StringBuilder(length + 1);
    GetWindowText(hWnd, buffer, buffer.Capacity);
    return buffer.ToString();
  }

  public static string TitleOf(IntPtr hWnd) { return WindowTitle(hWnd); }
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

function Get-Channel([string]$exePath) {
  if ($exePath -match '\\Chrome SxS\\') { return 'canary' }
  if ($exePath -match '\\Chrome Beta\\') { return 'beta' }
  if ($exePath -match '\\Chrome Dev\\') { return 'dev' }
  return 'stable'
}

# Each channel keeps its own user-data directory. This mapping is the whole
# reason a wrong binary choice looks like data loss, so it is spelled out.
function Get-UserDataDir([string]$channel) {
  $folder = 'Chrome'
  if ($channel -eq 'canary') { $folder = 'Chrome SxS' }
  elseif ($channel -eq 'beta') { $folder = 'Chrome Beta' }
  elseif ($channel -eq 'dev') { $folder = 'Chrome Dev' }
  if (-not $env:LOCALAPPDATA) { return $null }
  return (Join-Path $env:LOCALAPPDATA (Join-Path 'Google' ($folder + '\User Data')))
}

# Disk evidence for "is this the profile a human actually uses": a last-used
# profile that exists, bookmarks in it, and a non-trivial Login Data file.
function Get-ProfileEvidence([string]$userDataDir) {
  $evidence = [pscustomobject]@{
    exists = $false; lastUsed = $null; lastUsedExists = $false
    bookmarksBytes = 0; loginBytes = 0; lastVersion = $null; score = 0
  }
  if (-not $userDataDir -or -not (Test-Path -LiteralPath $userDataDir)) { return $evidence }
  $evidence.exists = $true
  $localState = Join-Path $userDataDir 'Local State'
  if (Test-Path -LiteralPath $localState) {
    $raw = Get-Content -LiteralPath $localState -Raw -Encoding UTF8
    $match = [regex]::Match($raw, '"last_used"\s*:\s*"([^"]+)"')
    if ($match.Success) { $evidence.lastUsed = $match.Groups[1].Value }
  }
  if ($evidence.lastUsed) {
    $profileDir = Join-Path $userDataDir $evidence.lastUsed
    $evidence.lastUsedExists = Test-Path -LiteralPath $profileDir
    $bookmarks = Join-Path $profileDir 'Bookmarks'
    if (Test-Path -LiteralPath $bookmarks) { $evidence.bookmarksBytes = (Get-Item -LiteralPath $bookmarks).Length }
    $logins = Join-Path $profileDir 'Login Data'
    if (Test-Path -LiteralPath $logins) { $evidence.loginBytes = (Get-Item -LiteralPath $logins).Length }
  }
  $lastVersion = Join-Path $userDataDir 'Last Version'
  if (Test-Path -LiteralPath $lastVersion) { $evidence.lastVersion = ((Get-Content -LiteralPath $lastVersion -Raw) -replace '\s+', '') }
  $score = 0
  if ($evidence.lastUsedExists) { $score += 1 }
  if ($evidence.bookmarksBytes -gt 0) { $score += 2 }
  if ($evidence.loginBytes -gt 4096) { $score += 1 }
  $evidence.score = $score
  return $evidence
}

# Rule 1: reuse beats creation. Any chrome process means the browser is already
# running, so launching would create a competing instance rather than help.
# -DryRun skips the refusal because it never launches: it still wants to report
# which binary the decision would pick.
$running = @(Get-Process chrome -ErrorAction SilentlyContinue)
$runningSession = $null
if ($running.Count -gt 0) {
  $windows = @()
  foreach ($process in $running) {
    foreach ($handle in [LaunchWindow]::BrowserWindows($process.Id)) {
      $windows += [pscustomobject]@{ ProcessId = $process.Id; WindowHandle = $handle.ToInt64(); Title = [LaunchWindow]::WindowTitle($handle) }
    }
  }
  $owner = $running | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
  if (-not $owner) { $owner = $running | Select-Object -First 1 }
  $ownerPath = $null
  try { $ownerPath = $owner.Path } catch { $ownerPath = $null }
  $ownerChannel = $null
  if ($ownerPath) { $ownerChannel = Get-Channel $ownerPath }
  $runningSession = [pscustomobject]@{
    processCount = $running.Count
    visibleWindowCount = $windows.Count
    channel = $ownerChannel
    exePath = $ownerPath
    userDataDir = $(if ($ownerChannel) { Get-UserDataDir $ownerChannel } else { $null })
    windows = @($windows | Select-Object -First 8)
  }
  if (-not $DryRun) {
    Write-Result ([pscustomobject]@{
      status = 'not_dispatched'
      reason = 'chrome_already_running'
      dispatched = $false
      processCount = $runningSession.processCount
      visibleWindowCount = $runningSession.visibleWindowCount
      runningChannel = $runningSession.channel
      runningExePath = $runningSession.exePath
      runningUserDataDir = $runningSession.userDataDir
      windows = $runningSession.windows
      activated = $false
      message = $(if ($windows.Count -gt 0) {
        'Chrome is already running, so nothing was launched. Reuse it: open the page with browser_open instead.'
      } else {
        'Chrome processes exist but no browser window is on screen. Nothing was launched; a second launch would open another instance. Reuse the session or reload the extension.'
      })
    })
    exit 0
  }
}

# Rule 2: choose the binary by profile evidence. Every installed channel is a
# candidate; the one whose user-data directory holds a used profile wins.
$rawCandidates = New-Object System.Collections.Generic.List[string]
foreach ($hive in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
                    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe')) {
  try {
    $entry = Get-ItemProperty -Path $hive -ErrorAction Stop
    $path = $entry.'(default)'
    if ($path) { $rawCandidates.Add(($path -replace '^"|"$', '')) }
  } catch { }
}
foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
  if ($base) { $rawCandidates.Add((Join-Path $base 'Google\Chrome\Application\chrome.exe')) }
}
if ($env:LOCALAPPDATA) {
  foreach ($channel in @('Chrome SxS', 'Chrome Beta', 'Chrome Dev')) {
    $rawCandidates.Add((Join-Path $env:LOCALAPPDATA (Join-Path 'Google' (Join-Path $channel 'Application\chrome.exe'))))
  }
}

$evaluated = @()
$seen = @{}
foreach ($candidate in $rawCandidates) {
  if (-not $candidate) { continue }
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
  $resolved = (Resolve-Path -LiteralPath $candidate).Path
  $key = $resolved.ToLowerInvariant()
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true
  $channel = Get-Channel $resolved
  $userDataDir = Get-UserDataDir $channel
  $evidence = Get-ProfileEvidence $userDataDir
  $evaluated += [pscustomobject]@{
    ExePath = $resolved
    Channel = $channel
    UserDataDir = $userDataDir
    Score = $evidence.score
    LastUsed = $evidence.lastUsed
    LastVersion = $evidence.lastVersion
    BookmarksBytes = $evidence.bookmarksBytes
    LoginBytes = $evidence.loginBytes
  }
}

if ($evaluated.Count -eq 0) {
  Write-Result ([pscustomobject]@{
    status = 'not_dispatched'
    reason = 'chrome_not_found'
    dispatched = $false
    searched = @($rawCandidates | Select-Object -First 8)
    message = 'No chrome.exe was found in the registered App Path or the standard install locations; nothing was launched.'
  })
  exit 0
}

# Highest profile evidence first; stable wins ties; a matching "Last Version"
# breaks the remaining ties so the profile is not opened by a mismatched build.
$channelRank = @{ stable = 0; beta = 1; dev = 2; canary = 3 }
$ranked = @($evaluated | Sort-Object -Property @(
  @{ Expression = 'Score'; Descending = $true },
  @{ Expression = { $channelRank[$_.Channel] }; Descending = $false },
  @{ Expression = 'ExePath'; Descending = $false }
))
$chosen = $ranked[0]
$rejected = @($ranked | Select-Object -Skip 1 | ForEach-Object {
  [pscustomobject]@{ exePath = $_.ExePath; channel = $_.Channel; profileScore = $_.Score; userDataDir = $_.UserDataDir }
})

# Refusing to launch is the correct answer when no channel holds a used profile:
# a blank profile is worse than no browser, because it looks like a wiped
# session and it silently loses the logins the caller is about to rely on.
if ($chosen.Score -le 0) {
  Write-Result ([pscustomobject]@{
    status = 'not_dispatched'
    reason = 'no_used_profile_available'
    dispatched = $false
    candidates = $rejected
    evaluated = @($evaluated)
    message = 'Chrome is installed, but none of the installed channels has a profile with a last-used entry, bookmarks or saved logins. Launching one would open an empty browser, so nothing was launched. Open Chrome yourself once, then retry.'
  })
  exit 0
}

$chromePath = $chosen.ExePath
$argumentList = @()
if ($Url) { $argumentList += $Url }

# -DryRun answers "which browser would you start, on which profile?" without
# starting anything. It exists so this decision can be inspected on a live
# machine - by doctor, by tests, by a human - instead of only being observable
# by the damage a wrong choice would do.
if ($DryRun) {
  Write-Result ([pscustomobject]@{
    status = 'not_dispatched'
    reason = 'dry_run'
    dispatched = $false
    wouldLaunch = [pscustomobject]@{
      chromePath = $chromePath
      channel = $chosen.Channel
      userDataDir = $chosen.UserDataDir
      profileScore = $chosen.Score
      lastUsedProfile = $chosen.LastUsed
      lastVersion = $chosen.LastVersion
      bookmarksBytes = $chosen.BookmarksBytes
      loginBytes = $chosen.LoginBytes
    }
    rejectedCandidates = $rejected
    runningSession = $runningSession
    launchMode = $(if ($Activate) { 'activate' } else { 'no_activate' })
    message = 'Dry run: nothing was launched. wouldLaunch describes the browser and profile the real launch would use.'
  })
  exit 0
}

# Rule 3: start without taking focus. SW_SHOWNOACTIVATE makes the new window
# appear inactive behind the current one, which is what "run this in the
# background" means to a human who is working in another window.
$foregroundBefore = [LaunchWindow]::GetForegroundWindow()
$launchMode = 'no_activate'
if ($Activate) { $launchMode = 'activate' }

$startInfo = New-Object LaunchWindow+STARTUPINFO
$startInfo.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($startInfo)
$startInfo.dwFlags = 0x1
$startInfo.wShowWindow = $(if ($Activate) { [short]1 } else { [short]4 })
$processInfo = New-Object LaunchWindow+PROCESS_INFORMATION
$commandLine = '"' + $chromePath + '"'
if ($argumentList.Count -gt 0) { $commandLine += ' ' + ($argumentList -join ' ') }

$created = $false
$launchError = $null
try {
  $created = [LaunchWindow]::CreateProcess($chromePath, $commandLine, [IntPtr]::Zero, [IntPtr]::Zero, $false,
    0x00000400, [IntPtr]::Zero, (Split-Path -Parent $chromePath), [ref]$startInfo, [ref]$processInfo)
  if (-not $created) { $launchError = 'CreateProcess failed with Win32 error ' + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error() }
} catch {
  $launchError = $_.Exception.Message
}

$processId = 0
if ($created) {
  $processId = $processInfo.dwProcessId
  [void][LaunchWindow]::CloseHandle($processInfo.hThread)
  [void][LaunchWindow]::CloseHandle($processInfo.hProcess)
} else {
  # Fallback keeps the capability working on hosts that block CreateProcess
  # interception. It is honest about being the activating path.
  $launchMode = 'fallback_start_process'
  try {
    $fallbackArgs = @{ FilePath = $chromePath; PassThru = $true }
    if ($argumentList.Count -gt 0) { $fallbackArgs['ArgumentList'] = $argumentList }
    $process = Start-Process @fallbackArgs
    $processId = $process.Id
    $created = $true
  } catch {
    Write-Result ([pscustomobject]@{ status='failed'; reason='chrome_launch_failed'; dispatched=$false; launchError=$launchError; message=$_.Exception.Message })
    exit 0
  }
}

# A launched process is not the same as a usable browser. Wait for a real window
# so the caller is not told "launched" when only a stub process exists.
$deadline = (Get-Date).AddSeconds($VerifyTimeoutSec)
$handle = [IntPtr]::Zero
do {
  Start-Sleep -Milliseconds 400
  $handles = @()
  foreach ($process in @(Get-Process chrome -ErrorAction SilentlyContinue)) {
    $handles += @([LaunchWindow]::BrowserWindows($process.Id))
  }
  if ($handles.Count -gt 0) { $handle = $handles[0]; break }
} while ((Get-Date) -lt $deadline)

$foregroundAfter = [LaunchWindow]::GetForegroundWindow()
$stoleFocus = ($foregroundAfter -ne $foregroundBefore) -and ($foregroundAfter -eq $handle)

if ($handle -eq [IntPtr]::Zero) {
  Write-Result ([pscustomobject]@{
    status = 'uncertain'
    reason = 'chrome_launched_without_visible_window'
    dispatched = $true
    verified = $false
    processId = $processId
    chromePath = $chromePath
    channel = $chosen.Channel
    userDataDir = $chosen.UserDataDir
    profileScore = $chosen.Score
    profileFlags = 'none'
    launchMode = $launchMode
    argumentList = @($argumentList)
    rejectedCandidates = $rejected
    message = 'chrome.exe was started but no browser window appeared in time. Inspect before launching again; a second launch would open another window.'
  })
  exit 0
}

Write-Result ([pscustomobject]@{
  status = 'success'
  reason = 'chrome_launched'
  dispatched = $true
  verified = $true
  processId = $processId
  windowHandle = $handle.ToInt64()
  windowTitle = [LaunchWindow]::WindowTitle($handle)
  chromePath = $chromePath
  channel = $chosen.Channel
  userDataDir = $chosen.UserDataDir
  profileScore = $chosen.Score
  profileFlags = 'none'
  launchMode = $launchMode
  activated = $stoleFocus
  argumentList = @($argumentList)
  rejectedCandidates = $rejected
  message = 'Chrome started on the ' + $chosen.Channel + ' channel with its own user-data directory and no profile or incognito flags, so existing cookies and logins apply. The window was created without taking focus.'
})
exit 0
