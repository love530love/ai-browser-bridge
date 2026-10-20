param([Parameter(Mandatory)][string]$StateDirectory)
$ErrorActionPreference = 'Stop'
# Preserve evidence before Start-Process truncates its redirected output files.
# This helper only copies local logs; it does not launch or stop any process.
$sources = @('server.log', 'server-error.log') | Where-Object {
  Test-Path -LiteralPath (Join-Path $StateDirectory $_) -PathType Leaf
}
if (-not $sources) { return }
$archive = Join-Path $StateDirectory ('service-history/' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $archive -Force | Out-Null
foreach ($name in $sources) {
  Copy-Item -LiteralPath (Join-Path $StateDirectory $name) -Destination (Join-Path $archive $name) -ErrorAction Stop
}
@{
  capturedAt = [DateTimeOffset]::UtcNow.ToString('o')
  reason = 'before-service-start'
  exitCause = 'unknown'
  files = @($sources)
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $archive 'metadata.json') -Encoding utf8
