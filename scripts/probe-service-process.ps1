$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$expected = [regex]::Escape((Join-Path $root 'src\server.js'))
$pattern = '^\s*(?:"[^"]*node(?:\.exe)?"|\S*node(?:\.exe)?)\s+(?:"' + $expected + '"|' + $expected + ')\s*$'
$found = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop | Where-Object { $_.CommandLine -match $pattern } | ForEach-Object { @{ id=[int]$_.ProcessId; startedTicks=[string]$_.CreationDate.ToUniversalTime().Ticks } })
@{ matches=$found } | ConvertTo-Json -Compress -Depth 3
