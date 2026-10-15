param(
  [string]$ExtensionId = 'mmopbppoabmhliflinadkgnedjpmbgig',
  [switch]$BestEffort,
  [int]$VerifyTimeoutSec = 15
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $projectRoot '.local/config.json') -Raw | ConvertFrom-Json
$expectedVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'extension/manifest.json') -Raw | ConvertFrom-Json).version
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
'@
$chrome = Get-Process chrome -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and [NativeWindow]::IsWindowVisible($_.MainWindowHandle) } |
  Select-Object -First 1
if (-not $chrome) {
  if ($BestEffort) { Write-Warning 'No visible Chrome window; extension reload was not attempted.'; exit 2 }
  throw 'No visible Chrome window found.'
}
[NativeWindow]::SetForegroundWindow($chrome.MainWindowHandle) | Out-Null
$shell = New-Object -ComObject WScript.Shell
$shell.SendKeys('^l'); $shell.SendKeys('chrome://extensions'); $shell.SendKeys('{ENTER}')
Start-Sleep -Milliseconds 1200
$root = [System.Windows.Automation.AutomationElement]::FromHandle($chrome.MainWindowHandle)
$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button)
$buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
$candidate = $null
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
foreach ($button in $buttons) {
  if (@('Reload','重新加载','Reload extension') -notcontains [string]$button.Current.Name) { continue }
  $node = $button
  $context = ''
  for ($i = 0; $i -lt 8 -and $node; $i++) {
    $context += ' ' + [string]$node.Current.Name + ' ' + [string]$node.Current.AutomationId
    $node = $walker.GetParent($node)
  }
  if ($context -match [regex]::Escape($ExtensionId) -or $context -match '自主浏览器|AI Browser Bridge') { $candidate = $button; break }
}
if (-not $candidate) {
  if ($BestEffort) { Write-Warning "Reload button for $ExtensionId was not exposed through Windows UI Automation."; exit 2 }
  throw "Reload button for extension $ExtensionId was not found. No action was taken."
}
$candidate.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Write-Host "Requested Reload for extension $ExtensionId."

# Reload is asynchronous. Give the service a chance to reconnect and report a
# useful result to upgrade.ps1; never click a second time automatically.
$deadline = (Get-Date).AddSeconds($VerifyTimeoutSec)
do {
  Start-Sleep -Milliseconds 500
  try {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$($config.port)/status" -Headers @{ Authorization = "Bearer $($config.agentToken)" } -TimeoutSec 2
    if ($status.connected -eq $true -and $status.extensionVersion -eq $expectedVersion) {
      Write-Host "Extension connection is healthy (version $($status.extensionVersion))."
      exit 0
    }
  } catch { }
} while ((Get-Date) -lt $deadline)
if ($BestEffort) { Write-Warning 'Reload was clicked, but the target version was not verified.'; exit 2 }
throw 'Reload was clicked, but the extension did not report connected before timeout.'
