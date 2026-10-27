# Unwraps the Chrome profile's AES key with the current user's DPAPI identity.
#
# Reads one base64 blob from stdin (the os_crypt.encrypted_key payload with its
# "DPAPI" prefix already stripped) and writes the base64 plaintext key to stdout.
# Nothing is written to disk and nothing is logged: the caller keeps the key in
# memory for the single decryption it needs.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
try {
  $b64 = [Console]::In.ReadToEnd().Trim()
  if (-not $b64) { throw 'No input' }
  $bytes = [Convert]::FromBase64String($b64)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
  [Console]::Out.Write([Convert]::ToBase64String($plain))
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
