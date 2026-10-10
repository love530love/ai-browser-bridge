$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.local\config.json') -Raw | ConvertFrom-Json
Set-Clipboard -Value $config.extensionToken
Write-Host 'Pairing key copied. Paste into the extension settings. Do not send it in chat.'
