# Fast, read-only process identity probe for the idle restart preflight.
# Get-CimInstance can take ~34s on some hosts (WMI autoload), which made an
# 8s probe look unreadable and refused safe restarts. NtQueryInformationProcess
# and QueryFullProcessImageNameW need no WMI service and answer in well under
# a second. Access is PROCESS_QUERY_LIMITED_INFORMATION only; nothing is
# signalled, written or changed.
param([Parameter(Mandatory)][int]$ProcessId)
$ErrorActionPreference = 'Stop'

if (-not ('BridgeProcessIdentity' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class BridgeProcessIdentity
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

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, StringBuilder builder, ref int size);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        IntPtr processInformation,
        int processInformationLength,
        out int returnLength);

    private static string ReadCommandLine(IntPtr handle, int processId)
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

    private static string ReadExecutablePath(IntPtr handle, int processId)
    {
        int size = 32768;
        StringBuilder builder = new StringBuilder(size);
        if (!QueryFullProcessImageNameW(handle, 0, builder, ref size))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "QueryFullProcessImageNameW failed for PID " + processId);
        return builder.ToString();
    }

    public static string[] Read(int processId)
    {
        IntPtr handle = OpenProcess(ProcessQueryLimitedInformation, false, (uint)processId);
        if (handle == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcess failed for PID " + processId);

        try
        {
            return new string[]
            {
                ReadCommandLine(handle, processId),
                ReadExecutablePath(handle, processId)
            };
        }
        finally
        {
            CloseHandle(handle);
        }
    }
}
'@
}

$values = [BridgeProcessIdentity]::Read($ProcessId)
[ordered]@{
  processId      = $ProcessId
  commandLine    = $values[0]
  executablePath = $values[1]
} | ConvertTo-Json -Compress
