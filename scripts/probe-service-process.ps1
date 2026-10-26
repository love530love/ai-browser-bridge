$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$expected = [regex]::Escape((Join-Path $root 'src\server.js'))
$pattern = '^\s*(?:"[^"]*node(?:\.exe)?"|\S*node(?:\.exe)?)\s+(?:"' + $expected + '"|' + $expected + ')\s*$'

if (-not ('BridgeNtProcessCommandLine' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class BridgeNtProcessCommandLine
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const int ProcessCommandLineInformation = 60;
    private const int StatusInfoLengthMismatch = unchecked((int)0xC0000004);

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        IntPtr processInformation,
        int processInformationLength,
        out int returnLength);

    public static string Read(int processId)
    {
        IntPtr handle = OpenProcess(ProcessQueryLimitedInformation, false, (uint)processId);
        if (handle == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess failed for PID " + processId);

        try
        {
            int required = 0;
            int status = NtQueryInformationProcess(
                handle, ProcessCommandLineInformation, IntPtr.Zero, 0, out required);
            if (status < 0 && status != StatusInfoLengthMismatch)
                throw new InvalidOperationException("NtQueryInformationProcess size probe failed: 0x" + status.ToString("X8"));
            if (required < Marshal.SizeOf(typeof(UnicodeString)) || required > 1048576)
                throw new InvalidOperationException("Invalid process command-line buffer size for PID " + processId);

            IntPtr buffer = Marshal.AllocHGlobal(required);
            try
            {
                status = NtQueryInformationProcess(
                    handle, ProcessCommandLineInformation, buffer, required, out required);
                if (status < 0)
                    throw new InvalidOperationException("NtQueryInformationProcess failed: 0x" + status.ToString("X8"));

                UnicodeString value = (UnicodeString)Marshal.PtrToStructure(buffer, typeof(UnicodeString));
                if ((value.Length & 1) != 0 || value.Length > value.MaximumLength)
                    throw new InvalidOperationException("Invalid command-line string for PID " + processId);
                if (value.Length == 0)
                    return String.Empty;
                if (value.Buffer == IntPtr.Zero)
                    throw new InvalidOperationException("Missing command-line buffer for PID " + processId);
                return Marshal.PtrToStringUni(value.Buffer, value.Length / 2);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        finally
        {
            CloseHandle(handle);
        }
    }
}
'@
}

$found = @()
foreach ($candidate in @(Get-Process -Name 'node' -ErrorAction SilentlyContinue)) {
  $commandLine = [BridgeNtProcessCommandLine]::Read([int]$candidate.Id)
  if ($commandLine -match $pattern) {
    $startedTicks = [string]$candidate.StartTime.ToUniversalTime().Ticks
    $found += @{ id=[int]$candidate.Id; startedTicks=$startedTicks }
  }
}
@{ matches=@($found) } | ConvertTo-Json -Compress -Depth 3
