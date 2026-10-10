# Register the AI Browser Bridge service to auto-start at user logon.
# Run once per machine. Safe to run repeatedly; switching methods removes the other.
#
#   .\install-autostart.ps1                    # Startup folder (default)
#   .\install-autostart.ps1 -Method Registry   # HKCU Run + hidden vbs shim
#
# StartupFolder is the default because it writes no registry key and drops no
# .vbs file; on machines with an EDR/antivirus agent the Run-key + wscript
# pattern is what gets flagged as suspicious persistence.
param(
  [ValidateSet('StartupFolder', 'Registry')]
  [string]$Method = 'StartupFolder'
)
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$localDir = Join-Path $root '.local'
$configPath = Join-Path $localDir 'config.json'
$nodePathFile = Join-Path $localDir 'node-path.txt'
$cmd = Join-Path $root 'bridge-autostart.cmd'
$vbs = Join-Path $root 'bridge-autostart.vbs'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$valueName = 'AIBrowserBridge'

function Test-PortListening([int]$port) {
  return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
}

# 1) Ensure a configuration exists and remember which node.exe we used.
$node = (Get-Command node.exe -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $configPath)) {
  & $node (Join-Path $root 'src\cli.js') setup | Out-Null
}
Set-Content -LiteralPath $nodePathFile -Value $node -Encoding ASCII
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$port = [int]$config.port

# 2) Launcher: probe the recorded node, fall back to PATH, and log everything.
# Node is started minimized and detached so the launcher exits immediately and
# the login flow is not blocked by a long-lived console window.
$cmdBody = @"
@echo off
setlocal
set "ROOT=$root"
set "LOG=%ROOT%\.local\server.log"
set "ERR=%ROOT%\.local\server-error.log"
set "STARTLOG=%ROOT%\.local\server-start.log"
echo --- %date% %time% bridge start attempt --- >> "%STARTLOG%"

rem Prefer the node recorded at install time; fall back to PATH. A missing node
rem is logged rather than shown, because nobody is looking at the screen at logon.
set "NODE="
if exist "%ROOT%\.local\node-path.txt" for /f "usebackq delims=" %%i in ("%ROOT%\.local\node-path.txt") do set "NODE=%%i"
if not defined NODE for /f "delims=" %%i in ('where node 2^>nul') do set "NODE=%%i"

if not defined NODE (
  echo FATAL: node.exe not found. Fix $localDir\node-path.txt or add node.exe to PATH. >> "%STARTLOG%"
  exit /b 1
)
echo using %NODE% >> "%STARTLOG%"
cd /d "%ROOT%"
start "AI Browser Bridge" /min cmd /c ""%NODE%" "%ROOT%\src\server.js" 1>> "%LOG%" 2>> "%ERR%"
echo --- %date% %time% launcher exited %errorlevel% --- >> "%STARTLOG%"
exit /b 0
"@
Set-Content -LiteralPath $cmd -Value $cmdBody -Encoding Default

# 3) Remove the method we are not installing, so the service is never started twice.
$startupDir = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startupDir 'AI Browser Bridge.lnk'
if ($Method -eq 'StartupFolder') {
  Remove-ItemProperty -LiteralPath $runKey -Name $valueName -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $vbs) { Remove-Item -LiteralPath $vbs -Force }
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($lnkPath)
  $lnk.TargetPath = $cmd
  $lnk.WorkingDirectory = $root
  $lnk.WindowStyle = 7
  $lnk.Description = 'AI Browser Bridge local bridge service'
  $lnk.Save()
} else {
  if (Test-Path -LiteralPath $lnkPath) { Remove-Item -LiteralPath $lnkPath -Force }
  $vbsBody = @"
Dim shell
Set shell = CreateObject("Wscript.Shell")
shell.Run Chr(34) & "$cmd" & Chr(34), 0, False
"@
  Set-Content -LiteralPath $vbs -Value $vbsBody -Encoding Default
  Set-ItemProperty -LiteralPath $runKey -Name $valueName -Value ('wscript.exe //B "' + $vbs + '"') -Force
}

# 4) Smoke start: prove the launcher actually works before we promise anything.
# Skipped when the service is already up, otherwise we would be verifying a
# port someone else bound and call it a success.
Write-Host 'Verifying the launcher can start the service...'
if (Test-PortListening $port) {
  Write-Host ("Already listening on 127.0.0.1:{0}; skipping the launch test." -f $port)
  Write-Host 'Run stop.ps1 first if you want the launcher itself retested.'
} else {
  Start-Process -FilePath $cmd -WorkingDirectory $root -WindowStyle Minimized | Out-Null
  $ok = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-PortListening $port) { $ok = $true; break }
  }
  if ($ok) { Write-Host ("OK: bridge is listening on 127.0.0.1:{0}." -f $port) }
  else { Write-Host ("WARN: did not start within 10s. See {0}" -f (Join-Path $localDir 'server-start.log')) }
}

Write-Host ''
Write-Host ("Method    : {0}" -f $Method)
if ($Method -eq 'StartupFolder') {
  Write-Host ("Shortcut  : {0}" -f $lnkPath)
  Write-Host 'Disable it any time in Task Manager > Startup apps.'
} else {
  Write-Host ("Registry  : HKCU\...\Run\{0}" -f $valueName)
}
Write-Host ("Launcher  : {0}" -f $cmd)
Write-Host 'Next logon starts the bridge automatically. The extension reconnects on its own.'
Write-Host 'Remove with: uninstall-autostart.ps1'
