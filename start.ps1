#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
& $nodePath (Join-Path $projectRoot 'src\cli.js') setup
if ($LASTEXITCODE -ne 0) { throw 'Setup failed' }
$config = Get-Content -LiteralPath (Join-Path $projectRoot '.local\config.json') -Raw | ConvertFrom-Json
try {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$($config.port)/status" -Headers @{ Authorization = "Bearer $($config.agentToken)" } -TimeoutSec 2
    if ($status.service -eq 'ai-browser-bridge') { Write-Host 'Bridge is already running.'; exit 0 }
} catch { }
$process = Start-Process -FilePath $nodePath -ArgumentList ('"' + (Join-Path $projectRoot 'src\server.js') + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectRoot '.local\server.log') -RedirectStandardError (Join-Path $projectRoot '.local\server-error.log') -PassThru
$process.Id | Set-Content -LiteralPath (Join-Path $projectRoot '.local\server.pid')
$lastError = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) { throw 'Service did not start. See .local/server-error.log.' }
    try {
        $status = Invoke-RestMethod -Uri "http://127.0.0.1:$($config.port)/status" -Headers @{ Authorization = "Bearer $($config.agentToken)" } -TimeoutSec 2
        if ($status.service -eq 'ai-browser-bridge') {
            $status | ConvertTo-Json -Depth 8
            exit 0
        }
    } catch {
        $lastError = $_.Exception.Message
    }
}
throw "Service status check failed after waiting. Last error: $lastError"
