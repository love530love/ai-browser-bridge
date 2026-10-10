param(
    [ValidateSet('status','tools','call','call-raw','doctor','allow-upload-root')][string]$Action = 'status',
    [string]$Tool,
    [string]$Json = '{}'
)
$ErrorActionPreference = 'Stop'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$entry = Join-Path $PSScriptRoot 'src/cli.js'
if ($Action -eq 'call' -or $Action -eq 'call-raw') {
    if (!$Tool) { throw 'Tool name required' }
    $Json | & $nodePath $entry $Action $Tool --stdin
} elseif ($Action -eq 'allow-upload-root') {
    if (!$Tool) { throw 'Absolute upload root required in -Tool' }
    & $nodePath $entry allow-upload-root $Tool
} else {
    & $nodePath $entry $Action
}
exit $LASTEXITCODE
