param(
  [Parameter(Mandatory)][ValidateSet('install', 'uninstall', 'status')][string]$Action,
  [string]$ExtensionId = '',
  [string]$HostName = 'com.aibridge.host',
  [string]$ProjectRoot = '',
  [string]$NodePath = ''
)

# Registers this project's native messaging host for the current Chrome profile.
#
# Three things have to agree or Chrome refuses to launch the host:
#   1. HKCU\Software\Google\Chrome\NativeMessagingHosts\<name> must point at a
#      manifest JSON;
#   2. that manifest's "path" must be an executable, and "allowed_origins" must
#      contain the exact chrome-extension://<id>/ origin of the extension that
#      calls connectNative - a wildcard is not accepted;
#   3. the host must speak the length-prefixed stdin/stdout protocol.
#
# The extension id is passed in because nothing in the filesystem reliably maps
# an unpacked extension's directory to its id; the extension reports its own id
# over the bridge handshake and the service hands it to this script.
#
# Output contract: exactly one JSON object on the last line.
$ErrorActionPreference = 'Stop'

function Emit($payload) { $payload | ConvertTo-Json -Depth 6 -Compress }

if (-not $ProjectRoot) {
  $ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}
$hostDir = Join-Path $ProjectRoot 'native-host'
$hostScript = Join-Path $hostDir 'host.js'
$launcher = Join-Path $hostDir 'aibridge-host.bat'
$manifestPath = Join-Path $hostDir "$HostName.json"
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

function Get-RegisteredManifest {
  try {
    $item = Get-ItemProperty -Path $registryPath -ErrorAction Stop
    return [string]$item.'(default)'
  } catch {
    return $null
  }
}

try {
  switch ($Action) {
    'status' {
      $registered = Get-RegisteredManifest
      $manifest = $null
      if ($registered -and (Test-Path -LiteralPath $registered)) {
        try { $manifest = Get-Content -LiteralPath $registered -Raw | ConvertFrom-Json } catch { $manifest = $null }
      }
      $origins = @()
      if ($manifest -and $manifest.allowed_origins) { $origins = @($manifest.allowed_origins) }
      $wanted = if ($ExtensionId) { "chrome-extension://$ExtensionId/" } else { $null }
      Emit([ordered]@{
        status = 'success'
        action = 'status'
        hostName = $HostName
        registered = [bool]$registered
        registryKey = $registryPath
        manifestPath = $registered
        manifestExists = [bool]($registered -and (Test-Path -LiteralPath $registered))
        launcherExists = (Test-Path -LiteralPath $launcher)
        hostScriptExists = (Test-Path -LiteralPath $hostScript)
        allowedOrigins = $origins
        extensionIdMatches = if ($wanted) { $origins -contains $wanted } else { $null }
        expectedOrigin = $wanted
        usable = [bool]($registered -and (Test-Path -LiteralPath $registered) -and (Test-Path -LiteralPath $launcher) -and (-not $wanted -or ($origins -contains $wanted)))
      })
    }
    'install' {
      if (-not (Test-Path -LiteralPath $hostScript)) {
        Emit([ordered]@{ status = 'failed'; action = 'install'; reason = 'host_script_missing'; path = $hostScript; message = 'native-host/host.js is not in this project, so there is nothing to register.' })
        break
      }
      if (-not $ExtensionId -or $ExtensionId -notmatch '^[a-p]{32}$') {
        Emit([ordered]@{
          status = 'denied'
          action = 'install'
          reason = 'extension_id_required'
          message = 'A native host manifest must name the exact chrome-extension://<id>/ origin allowed to launch it, and Chrome does not accept a wildcard. The extension reports its own id over the bridge handshake; pass that 32-character id. Nothing was written.'
        })
        break
      }
      if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath)) {
        $candidate = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) {
          Emit([ordered]@{ status = 'failed'; action = 'install'; reason = 'node_not_found'; message = 'No node.exe was found to put in the launcher. Pass -NodePath.' })
          break
        }
        $NodePath = $candidate
      }
      # The launcher is a .bat because a native messaging manifest path must be
      # something Windows can start, and a .js file is not. It forwards stdin,
      # stdout and argv untouched, which is all the protocol needs.
      $bat = "@echo off`r`n`"$NodePath`" `"$hostScript`" %*`r`n"
      Set-Content -LiteralPath $launcher -Value $bat -Encoding ASCII -NoNewline

      $manifest = [ordered]@{
        name = $HostName
        description = 'AI Browser Bridge native host: system info, path checks and audited command execution for the connected agent.'
        path = $launcher
        type = 'stdio'
        allowed_origins = @("chrome-extension://$ExtensionId/")
      }
      $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

      if (-not (Test-Path -LiteralPath $registryPath)) { New-Item -Path $registryPath -Force | Out-Null }
      Set-ItemProperty -Path $registryPath -Name '(default)' -Value $manifestPath

      $registered = Get-RegisteredManifest
      Emit([ordered]@{
        status = 'success'
        action = 'install'
        hostName = $HostName
        registryKey = $registryPath
        manifestPath = $manifestPath
        launcherPath = $launcher
        nodePath = $NodePath
        allowedOrigins = @("chrome-extension://$ExtensionId/")
        verified = ([string]$registered -eq $manifestPath)
        note = 'Chrome reads this registry key at launch time, so the host is usable immediately; no browser restart is needed. The next connectNative call either finds it or reports native_host_not_registered.'
      })
    }
    'uninstall' {
      $existed = [bool](Test-Path -LiteralPath $registryPath)
      if ($existed) { Remove-Item -LiteralPath $registryPath -Recurse -Force }
      $manifestRemoved = $false
      if (Test-Path -LiteralPath $manifestPath) { Remove-Item -LiteralPath $manifestPath -Force; $manifestRemoved = $true }
      Emit([ordered]@{
        status = 'success'
        action = 'uninstall'
        hostName = $HostName
        registryKeyRemoved = $existed
        manifestRemoved = $manifestRemoved
        launcherKept = (Test-Path -LiteralPath $launcher)
        note = 'The launcher is kept so a reinstall does not have to rebuild it. Nothing else on the machine was touched.'
      })
    }
  }
} catch {
  Emit([ordered]@{ status = 'failed'; action = $Action; reason = 'native_host_registration_failed'; message = $_.Exception.Message })
  exit 1
}
