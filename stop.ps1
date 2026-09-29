#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot '.local\server.pid'
if (!(Test-Path -LiteralPath $pidFile)) { Write-Host 'No managed service PID.'; exit }
$bridgePid = [int](Get-Content -LiteralPath $pidFile -Raw)
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $bridgePid"
$expectedScript = Join-Path $PSScriptRoot 'src\server.js'
if ($process -and $process.Name -eq 'node.exe' -and $process.CommandLine.Contains($expectedScript)) {
    Stop-Process -Id $bridgePid
    Write-Host 'Bridge stopped. In-flight actions may already have run; inspect the page before retrying.'
} elseif ($process) { throw 'PID belongs to another process. Refusing to stop it.' }
