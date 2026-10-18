function Invoke-BoundedProcess {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [Parameter(Mandatory)][string]$WorkingDirectory,
    [ValidateRange(1, 300)][int]$TimeoutSec = 240
  )
  $info = [System.Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $FilePath
  $info.WorkingDirectory = $WorkingDirectory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  foreach ($argument in $ArgumentList) { $info.ArgumentList.Add($argument) }
  $child = [System.Diagnostics.Process]::new()
  $child.StartInfo = $info
  try {
    if (-not $child.Start()) { throw 'Could not start dependency installation.' }
    if (-not $child.WaitForExit($TimeoutSec * 1000)) {
      # Only terminate the process tree started by this invocation.
      $child.Kill($true)
      if (-not $child.WaitForExit(5000)) { throw 'Timed-out installer could not be stopped.' }
      throw 'Dependency installation timed out; its process tree was stopped. No extension reload was attempted.'
    }
    if ($child.ExitCode -ne 0) { throw "Dependency installation failed with exit code $($child.ExitCode)." }
  } finally { $child.Dispose() }
}
