#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$pwshPath = (Get-Command pwsh.exe -ErrorAction Stop).Source
& $pwshPath -NoProfile -File (Join-Path $PSScriptRoot 'stop.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Stop failed' }
& $pwshPath -NoProfile -File (Join-Path $PSScriptRoot 'start.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Start failed' }
Write-Host 'Reload the extension in chrome://extensions, then reconnect.'
