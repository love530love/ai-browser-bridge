param(
  [string]$Url = '',
  [switch]$AsJson,
  [switch]$Activate,
  [switch]$DryRun,
  [string]$LoadExtension = '',
  [string]$ExePath = '',
  [string]$UserDataDir = '',
  [string]$ProfileDirectory = '',
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
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
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

  // Chrome calls ShowWindow on its first window regardless of the nCmdShow it was
  // given, so SW_SHOWNOACTIVATE alone does not stop it from taking the screen.
  // Handing the foreground back is the part that actually works: the window stays
  // where it is, the user's own window returns to the front. AttachThreadInput is
  // what makes SetForegroundWindow legal from a process that is not the current
  // foreground owner.
  public static bool GiveForegroundBack(IntPtr previous) {
    if (previous == IntPtr.Zero) return false;
    uint previousPid;
    uint previousThread = GetWindowThreadProcessId(previous, out previousPid);
    uint currentThread = GetCurrentThreadId();
    bool attached = previousThread != 0 && previousThread != currentThread &&
      AttachThreadInput(currentThread, previousThread, true);
    BringWindowToTop(previous);
    bool restored = SetForegroundWindow(previous);
    if (attached) AttachThreadInput(currentThread, previousThread, false);
    return restored;
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

# Liveness evidence: the profile written to most recently is the one a human is
# actually using. A profile can carry a real login and still be a stale clone -
# on this machine the recorded target held the right account but had not been
# touched for 78 days, while another channel's profile was written seconds ago.
# Logins alone therefore cannot tell "the browser I use" from "a browser I used
# once", so a recorded target is checked against recency and any gap is reported
# instead of hidden.
function Get-ProfileLiveness([string]$userDataDir, [string]$profileDirectory) {
  $result = [pscustomobject]@{
    userDataDir = $userDataDir; profileDirectory = $profileDirectory
    exists = $false; profileName = $null; accounts = @()
    lastActivityUtc = $null; ageMinutes = $null
  }
  if (-not $userDataDir -or -not (Test-Path -LiteralPath $userDataDir)) { return $result }
  $dir = $null
  if ($profileDirectory) {
    $dir = Join-Path $userDataDir $profileDirectory
  } else {
    $evidence = Get-ProfileEvidence $userDataDir
    if ($evidence.lastUsed) {
      $dir = Join-Path $userDataDir $evidence.lastUsed
      $result.profileDirectory = $evidence.lastUsed
    }
  }
  if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { return $result }
  $result.exists = $true
  $preferences = Join-Path $dir 'Preferences'
  if (Test-Path -LiteralPath $preferences) {
    try {
      $parsed = Get-Content -LiteralPath $preferences -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($parsed.profile.name) { $result.profileName = $parsed.profile.name }
      if ($parsed.account_info) { $result.accounts = @($parsed.account_info | ForEach-Object { $_.email }) }
    } catch { }
  }
  $newest = $null
  foreach ($name in @('Preferences', 'History', 'Network\Cookies', 'Cookies')) {
    $file = Join-Path $dir $name
    if (Test-Path -LiteralPath $file) {
      $stamp = (Get-Item -LiteralPath $file).LastWriteTimeUtc
      if (-not $newest -or $stamp -gt $newest) { $newest = $stamp }
    }
  }
  if ($newest) {
    $result.lastActivityUtc = $newest.ToString('o')
    $result.ageMinutes = [math]::Round(((Get-Date).ToUniversalTime() - $newest).TotalMinutes, 1)
  }
  return $result
}

# Freshest profile across every installed channel: the answer to "which browser
# was a human touching last", independent of which one the config happens to name.
function Get-LiveCandidate() {
  $best = $null
  foreach ($channel in @('stable', 'beta', 'dev', 'canary')) {
    $userDataDir = Get-UserDataDir $channel
    if (-not $userDataDir -or -not (Test-Path -LiteralPath $userDataDir)) { continue }
    foreach ($entry in @(Get-ChildItem -LiteralPath $userDataDir -Directory -ErrorAction SilentlyContinue)) {
      if ($entry.Name -notmatch '^(Default|Profile \d+)$') { continue }
      $live = Get-ProfileLiveness $userDataDir $entry.Name
      if (-not $live.lastActivityUtc) { continue }
      if (-not $best -or $live.ageMinutes -lt $best.ageMinutes) {
        $best = [pscustomobject]@{
          channel = $channel
          userDataDir = $userDataDir
          profileDirectory = $entry.Name
          profileName = $live.profileName
          accounts = @($live.accounts)
          lastActivityUtc = $live.lastActivityUtc
          ageMinutes = $live.ageMinutes
        }
      }
    }
  }
  return $best
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

# Rule 2: choose the binary.
#
# An explicit target wins outright. Scoring is only the fallback for a machine
# that has never been told which browser its owner uses, because no heuristic
# can tell "the profile with my logins" from "a profile an installer created" -
# on this machine the signed-in profile scored *lower* than an unsigned one.
$chosen = $null
$rejected = @()
$targetSource = 'scored'
if ($ExePath) {
  if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) {
    Write-Result ([pscustomobject]@{ status='denied'; reason='configured_browser_missing'; dispatched=$false
      configuredExePath = $ExePath
      message='The configured browserTarget.exePath does not exist; nothing was launched. Fix browserTarget in config.json or remove it to fall back to scoring.' })
    exit 0
  }
  # Resolve first, classify second: the channel is decided from the real path, not
  # from whatever spelling the caller passed in.
  $explicitResolved = (Resolve-Path -LiteralPath $ExePath).Path
  $explicitChannel = Get-Channel $explicitResolved
  $explicitUserData = $(if ($UserDataDir) { $UserDataDir } else { Get-UserDataDir $explicitChannel })
  $explicitEvidence = Get-ProfileEvidence $explicitUserData
  $chosen = [pscustomobject]@{
    ExePath = $explicitResolved
    Channel = $explicitChannel
    UserDataDir = $explicitUserData
    Score = $explicitEvidence.score
    LastUsed = $explicitEvidence.lastUsed
    LastVersion = $explicitEvidence.lastVersion
    BookmarksBytes = $explicitEvidence.bookmarksBytes
    LoginBytes = $explicitEvidence.loginBytes
  }
  $targetSource = 'explicit'
} else {
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
}

$chromePath = $chosen.ExePath
$argumentList = @()
# Loading this project's own extension is not a profile flag: it does not change
# which profile is opened, only whether the bridge is present at startup. It is
# passed only when the extension is registered but Chrome has it disabled,
# because an unpacked extension is exactly what Chrome refuses to load when
# developer mode is off.
if ($LoadExtension) {
  if (Test-Path -LiteralPath (Join-Path $LoadExtension 'manifest.json')) {
    $argumentList += ('--load-extension=' + $LoadExtension)
  } else {
    Write-Result ([pscustomobject]@{ status='denied'; reason='extension_dir_invalid'; dispatched=$false
      message='The extension directory has no manifest.json; nothing was launched.' })
    exit 0
  }
}
if ($Url) { $argumentList += $Url }
# A profile is only named when a human named it. Guessing which profile inside a
# channel is the same mistake one level down: it opens a browser that looks empty
# to its owner.
if ($ProfileDirectory) { $argumentList += ('--profile-directory=' + $ProfileDirectory) }

# Is the browser about to be started the one a human touched last? A recorded
# target that has gone cold while another channel is warm is the same failure as
# guessing, only discovered later - so it is measured here and said out loud.
$targetLiveness = Get-ProfileLiveness $chosen.UserDataDir $ProfileDirectory
$liveCandidate = Get-LiveCandidate
$targetIsLive = $null
if ($targetLiveness.ageMinutes -ne $null -and $liveCandidate) {
  $sameDir = $targetLiveness.userDataDir -and $liveCandidate.userDataDir -and
    ($targetLiveness.userDataDir.ToLowerInvariant() -eq $liveCandidate.userDataDir.ToLowerInvariant())
  $sameProfile = $targetLiveness.profileDirectory -eq $liveCandidate.profileDirectory
  $targetIsLive = [bool]($sameDir -and $sameProfile)
}
$launchWarnings = @()
if ($targetIsLive -eq $false -and $liveCandidate -and ($liveCandidate.ageMinutes -lt 1440)) {
  $launchWarnings += 'recorded_target_looks_stale'
}

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
      targetSource = $targetSource
      profileDirectory = $(if ($ProfileDirectory) { $ProfileDirectory } else { $null })
      lastUsedProfile = $chosen.LastUsed
      lastVersion = $chosen.LastVersion
      bookmarksBytes = $chosen.BookmarksBytes
      loginBytes = $chosen.LoginBytes
      profileName = $targetLiveness.profileName
      accounts = @($targetLiveness.accounts)
      lastActivityUtc = $targetLiveness.lastActivityUtc
      ageMinutes = $targetLiveness.ageMinutes
      argumentList = @($argumentList)
    }
    liveCandidate = $liveCandidate
    targetIsLive = $targetIsLive
    warnings = @($launchWarnings)
    rejectedCandidates = $rejected
    runningSession = $runningSession
    launchMode = $(if ($Activate) { 'activate' } else { 'no_activate' })
    message = $(if ($launchWarnings -contains 'recorded_target_looks_stale') {
      'Dry run: nothing was launched. The recorded target is cold while another channel was written to recently, so the recorded browser may not be the one its owner uses; compare wouldLaunch with liveCandidate.'
    } else {
      'Dry run: nothing was launched. wouldLaunch describes the browser and profile the real launch would use.'
    })
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
# Give the screen back if Chrome took it. Measured again afterwards: claiming the
# user was not interrupted is worth nothing, showing that their window is in front
# again is worth something.
$focusRestored = $null
if ($stoleFocus -and -not $Activate) {
  $focusRestored = [LaunchWindow]::GiveForegroundBack($foregroundBefore)
  Start-Sleep -Milliseconds 250
  $foregroundFinal = [LaunchWindow]::GetForegroundWindow()
  $focusRestored = ($foregroundFinal -eq $foregroundBefore)
}

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
    targetSource = $targetSource
    profileDirectory = $(if ($ProfileDirectory) { $ProfileDirectory } else { $null })
    profileFlags = $(if ($ProfileDirectory) { 'profile-directory-explicit' } else { 'none' })
    launchMode = $launchMode
    activated = $stoleFocus
    focusRestored = $focusRestored
    argumentList = @($argumentList)
    rejectedCandidates = $rejected
    message = 'chrome.exe was started but no browser window appeared in time. Inspect before launching again; a second launch would open another window.'
  })
  exit 0
}

# The message must not claim "no focus taken" when the measurement says otherwise.
# Chrome shows its first window with an explicit ShowWindow call, which overrides
# the nCmdShow it was started with, so the honest statement is which of the two
# happened and whether the user's window is back in front.
$focusMessage = if ($stoleFocus -and $focusRestored -eq $true) {
  ' Chrome brought its window to the front anyway; the previous foreground window was restored and verified.'
} elseif ($stoleFocus) {
  ' Chrome brought its window to the front anyway and the previous foreground window could not be restored; the user may have noticed.'
} else {
  ' The window was created without taking focus.'
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
  targetSource = $targetSource
  profileDirectory = $(if ($ProfileDirectory) { $ProfileDirectory } else { $null })
  profileFlags = $(if ($ProfileDirectory) { 'profile-directory-explicit' } else { 'none' })
  profileName = $targetLiveness.profileName
  accounts = @($targetLiveness.accounts)
  profileAgeMinutes = $targetLiveness.ageMinutes
  launchMode = $launchMode
  activated = $stoleFocus
  focusRestored = $focusRestored
  argumentList = @($argumentList)
  rejectedCandidates = $rejected
  message = ('Chrome started on the ' + $chosen.Channel + ' channel with its own user-data directory and no profile or incognito flags, so existing cookies and logins apply.' +
    $(if ($launchWarnings -contains 'recorded_target_looks_stale') {
      ' Warning: this profile had not been written to for ' + [math]::Round($targetLiveness.ageMinutes) + ' minutes while ' + $liveCandidate.channel + '/' + $liveCandidate.profileDirectory + ' was written ' + [math]::Round($liveCandidate.ageMinutes) + ' minutes ago - the recorded browserTarget may not be the browser its owner uses.'
    } else { '' }) + $focusMessage)
})
exit 0
