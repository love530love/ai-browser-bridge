$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$rootKey = [IO.Path]::GetFullPath($projectRoot).ToLowerInvariant()
$lockKey = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($rootKey))).Substring(0,24)
$startupMutex = [Threading.Mutex]::new($false, "Local\AIBridgeStart-$lockKey")
$startupOwned = $false
try {
try { $startupOwned = $startupMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $startupOwned = $true }
if (-not $startupOwned) { Write-Host 'Bridge startup is already in progress. Check doctor after it completes.'; exit 0 }
$pauseFile = Join-Path $projectRoot '.local/service-paused'
# Guarded on purpose: a hard Remove-Item on a path that is not there is a no-op
# for PowerShell, but any filesystem shim that fails closed on delete turns the
# normal "no pause marker" case into a startup failure.
if (Test-Path -LiteralPath $pauseFile) { Remove-Item -LiteralPath $pauseFile -Force -ErrorAction SilentlyContinue }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
& $nodePath (Join-Path $projectRoot 'src\cli.js') setup
if ($LASTEXITCODE -ne 0) { throw 'Setup failed' }
$config = Get-Content -LiteralPath (Join-Path $projectRoot '.local\config.json') -Raw | ConvertFrom-Json
try {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$($config.port)/status" -Headers @{ Authorization = "Bearer $($config.agentToken)" } -TimeoutSec 2
    if ($status.service -eq 'ai-browser-bridge') { Write-Host 'Bridge is already running.'; exit 0 }
} catch { }
try {
    & (Join-Path $projectRoot 'scripts/preserve-service-logs.ps1') -StateDirectory (Join-Path $projectRoot '.local')
} catch {
    # A locked log or full disk must not disable recovery. Surface the evidence gap.
    Write-Warning "Could not preserve previous service logs: $($_.Exception.Message)"
}
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
} finally {
    if ($startupOwned) { $startupMutex.ReleaseMutex() }
    $startupMutex.Dispose()
}
