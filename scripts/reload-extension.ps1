param(
  [string]$ExtensionId = 'mmopbppoabmhliflinadkgnedjpmbgig',
  [switch]$BestEffort
)

$ErrorActionPreference = 'Stop'
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
  if ($BestEffort) { Write-Warning 'No visible Chrome window; extension reload was not attempted.'; exit 0 }
  throw 'No visible Chrome window found.'
}
[NativeWindow]::SetForegroundWindow($chrome.MainWindowHandle) | Out-Null
$shell = New-Object -ComObject WScript.Shell
$shell.SendKeys('^l'); $shell.SendKeys('chrome://extensions'); $shell.SendKeys('{ENTER}')
Start-Sleep -Milliseconds 1200
$root = [System.Windows.Automation.AutomationElement]::RootElement
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
  if ($BestEffort) { Write-Warning "Reload button for $ExtensionId was not exposed through Windows UI Automation."; exit 0 }
  throw "Reload button for extension $ExtensionId was not found. No action was taken."
}
$candidate.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Write-Host "Requested Reload for extension $ExtensionId."
