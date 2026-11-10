# Resolve the absolute path of the node/pwsh binary the bridge should use.
#
# Why this exists: the PATH a logon-launched supervisor sees is not necessarily
# the PATH an interactive shell had. A portable pwsh prepends its own directory,
# and AI toolchains inject a node.exe that only exists for that one session. If
# such a path is selected at install time, the bridge works until reboot and
# then quietly fails. install-autostart.ps1 records the resolved binaries in
# .local/runtime.json; every entry point reads that first.
#
# A pinned path that no longer exists is NOT an error to hide: warn, then fall
# back to Get-Command so a fresh checkout (no runtime.json yet) still works.
function Resolve-BridgeBinary {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][ValidateSet('node', 'pwsh')][string]$Kind
  )
  $runtimeFile = Join-Path $Root '.local\runtime.json'
  if (Test-Path -LiteralPath $runtimeFile -PathType Leaf) {
    try {
      $runtime = Get-Content -LiteralPath $runtimeFile -Raw -ErrorAction Stop | ConvertFrom-Json
      $pinned = if ($Kind -eq 'node') { $runtime.node } else { $runtime.pwsh }
      if ($pinned -and (Test-Path -LiteralPath $pinned -PathType Leaf)) { return $pinned }
      if ($pinned) { Write-Warning "runtime.json 记录的 $Kind 路径已不可用，回退 PATH 解析：$pinned" }
    } catch {
      Write-Warning "runtime.json 无法读取，回退 PATH 解析：$($_.Exception.Message)"
    }
  }
  return (Get-Command "$($Kind).exe" -ErrorAction Stop).Source
}
