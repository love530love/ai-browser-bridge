# Register the AI Browser Bridge service to auto-start at user logon.
# Run once per machine: pwsh -File install-autostart.ps1 (or just open it).
# Safe to run repeatedly; both the registry entry and launcher are overwritten.
# Pair the extension once after the service is running, then save the key.
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$server = Join-Path $root 'src\server.js'
$vbs = Join-Path $root 'bridge-autostart.vbs'

# Hidden window launcher. vbscript + WScript.Shell.Run with WindowStyle=0 means
# no console window flashes for the user when they log in.
$vbsBody = @"
' Auto-generated launcher for the AI Browser Bridge service.
' Started by HKCU\...\Run on user logon. Safe to delete after uninstall.
Dim shell, node, server
Set shell = CreateObject("Wscript.Shell")
node = "$node"
server = "$server"
shell.Run Chr(34) & node & Chr(34) & " " & Chr(34) & server & Chr(34), 0, False
"@
Set-Content -LiteralPath $vbs -Value $vbsBody -Encoding Default

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$valueName = 'AIBrowserBridge'
$command = 'wscript.exe //B "' + $vbs + '"'
Set-ItemProperty -LiteralPath $runKey -Name $valueName -Value $command -Force

Write-Host ("Registered: HKCU\Software\Microsoft\Windows\CurrentVersion\Run\{0}" -f $valueName)
Write-Host ("Command   : {0}" -f $command)
Write-Host ("Launcher  : {0}" -f $vbs)
Write-Host 'The bridge service will auto-start at your next logon.'
Write-Host 'The extension reconnects on its own once the service is listening.'
Write-Host 'Remove with: pwsh -File uninstall-autostart.ps1'