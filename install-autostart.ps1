# Install a per-user hidden PowerShell 7 health supervisor.
param([ValidateSet('StartupFolder','Registry')][string]$Method = 'StartupFolder')
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node (Join-Path $root 'src/cli.js') setup | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Setup failed' }
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$linkPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'AI Browser Bridge.lnk'
$watcher = Join-Path $root 'scripts/watch-service.ps1'
$arguments = '-NoProfile -WindowStyle Hidden -File "' + $watcher + '"'
if ($Method -eq 'StartupFolder') {
  Remove-ItemProperty -LiteralPath $runKey -Name AIBrowserBridge -ErrorAction SilentlyContinue
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($linkPath)
  $shortcut.TargetPath = $pwsh
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = $root
  $shortcut.WindowStyle = 7
  $shortcut.Description = 'AI Browser Bridge health supervisor (PowerShell 7)'
  $shortcut.Save()
} else {
  Remove-Item -LiteralPath $linkPath -ErrorAction SilentlyContinue
  New-Item -Path $runKey -Force | Out-Null
  Set-ItemProperty -LiteralPath $runKey -Name AIBrowserBridge -Value ('"' + $pwsh + '" ' + $arguments)
}
# Cleared through the .NET API, not Remove-Item: a filesystem shim that fails
# closed on delete would otherwise abort the install on a path that may not even
# exist, and the shim can shadow the cmdlet but not [System.IO.File].
foreach ($stale in @('.local/watchdog-disabled', '.local/service-paused')) {
  $stalePath = Join-Path $root $stale
  if ([System.IO.File]::Exists($stalePath)) {
    try { [System.IO.File]::Delete($stalePath) } catch { Write-Host "Left $stale in place: $($_.Exception.Message)" }
  }
}
Start-Process -FilePath $pwsh -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden | Out-Null
Write-Host 'Health supervisor installed and launched. Check .local/watchdog-status.json and npm run doctor.'
Write-Host 'stop.ps1 pauses recovery; start.ps1 resumes it. uninstall-autostart.ps1 disables the supervisor.'
