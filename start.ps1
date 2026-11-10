$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
. (Join-Path $projectRoot 'scripts\resolve-runtime.ps1')
$rootKey = [IO.Path]::GetFullPath($projectRoot).ToLowerInvariant()
$lockKey = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($rootKey))).Substring(0,24)
$startupMutex = [Threading.Mutex]::new($false, "Local\AIBridgeStart-$lockKey")
$startupOwned = $false
try {
try { $startupOwned = $startupMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $startupOwned = $true }
if (-not $startupOwned) { Write-Host 'Bridge startup is already in progress. Check doctor after it completes.'; exit 0 }
$pauseFile = Join-Path $projectRoot '.local/service-paused'
# Deleted through the .NET API rather than Remove-Item on purpose. A pause
# marker left behind by stop.ps1 must never be able to block a start: any
# filesystem shim that fails closed on delete turns this cleanup into a fatal
# startup error (measured here: SAFE_DELETE_FAIL_CLOSED / trash-failed), and a
# cmdlet shim can shadow Remove-Item but not [System.IO.File].
if ([System.IO.File]::Exists($pauseFile)) {
  try { [System.IO.File]::Delete($pauseFile) }
  catch { Write-Host "Pause marker could not be cleared and was left in place: $($_.Exception.Message)" }
}
$nodePath = Resolve-BridgeBinary -Root $projectRoot -Kind node
& $nodePath (Join-Path $projectRoot 'src\cli.js') setup
if ($LASTEXITCODE -ne 0) { throw 'Setup failed' }
$config = Get-Content -LiteralPath (Join-Path $projectRoot '.local\config.json') -Raw | ConvertFrom-Json
# -NoProxy is required: this is a loopback call. An HTTP_PROXY injected by a
# proxy tool (or duplicated as both HTTP_PROXY and http_proxy) can swallow it,
# which otherwise looks exactly like "the service did not start".
try {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$($config.port)/status" -Headers @{ Authorization = "Bearer $($config.agentToken)" } -TimeoutSec 2 -NoProxy
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
        $status = Invoke-RestMethod -Uri "http://127.0.0.1:$($config.port)/status" -Headers @{ Authorization = "Bearer $($config.agentToken)" } -TimeoutSec 2 -NoProxy
        if ($status.service -eq 'ai-browser-bridge') {
            $status | ConvertTo-Json -Depth 8
            exit 0
        }
    } catch {
        $lastError = $_.Exception.Message
    }
}
# A listener that never answers /status is a different fault from no listener
# at all: the former may be another process owning the port or a proxy eating
# the loopback request, while the latter means our own process died. Say which
# one was observed instead of handing both cases the same "check the logs".
$tcp = [Net.Sockets.TcpClient]::new()
try { $portListening = $tcp.ConnectAsync('127.0.0.1', [int]$config.port).Wait(1000) -and $tcp.Connected } catch { $portListening = $false } finally { $tcp.Dispose() }
if ($portListening) {
    throw "本机 $($config.port) 端口已有监听，但带密钥的 /status 始终不通：可能是其它进程占用端口、服务仍在启动，或代理吞掉了本机请求。请用 Get-NetTCPConnection -LocalPort $($config.port) 查 OwningProcess，并运行 doctor-lite.bat 检查宿主环境。Last error: $lastError"
}
throw "服务启动后 $($config.port) 端口始终无监听，进程可能已退出：请查看 .local/server-error.log 与 .local/watchdog.jsonl。Last error: $lastError"
} finally {
    if ($startupOwned) { $startupMutex.ReleaseMutex() }
    $startupMutex.Dispose()
}
