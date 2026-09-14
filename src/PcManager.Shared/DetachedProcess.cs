using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace PcManager.Shared;

/// <summary>
/// 부모 프로세스가 곧 종료돼도 살아남는 완전히 분리된 프로세스를 실행한다.
/// 서비스가 자기 자신을 업데이트할 때(설치기가 서비스를 멈춘 뒤 파일 교체) 쓴다.
/// 일반 자식 프로세스는 서비스가 멈추면 함께 정리될 수 있어 이 방식이 필요하다.
/// </summary>
public static class DetachedProcess
{
    private const uint DETACHED_PROCESS = 0x00000008;
    private const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    private const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    private const uint CREATE_NO_WINDOW = 0x08000000;

    public static void Start(string exePath, string arguments, string? workingDirectory = null)
    {
        var baseFlags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW;

        // 잡(job)에 속해 있으면 잡에서 분리해 부모와 독립시킨다.
        // 잡에 속하지 않은 경우 BREAKAWAY 플래그로 실패할 수 있어, 실패하면 그 플래그 없이 재시도한다.
        if (TryCreate(exePath, arguments, workingDirectory, baseFlags | CREATE_BREAKAWAY_FROM_JOB, out var error))
            return;
        if (TryCreate(exePath, arguments, workingDirectory, baseFlags, out error))
            return;

        throw new Win32Exception(error, $"프로세스를 시작할 수 없습니다: {exePath}");
    }

    private static bool TryCreate(string exePath, string arguments, string? workingDirectory, uint flags, out int error)
    {
        var startupInfo = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>() };
        // CreateProcess는 커맨드라인 버퍼를 수정할 수 있으므로 가변 버퍼(StringBuilder)를 넘긴다
        var commandLine = new StringBuilder($"\"{exePath}\" {arguments}");

        if (CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero,
                workingDirectory, ref startupInfo, out var info))
        {
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
            error = 0;
            return true;
        }

        error = Marshal.GetLastWin32Error();
        return false;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(
        string? lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
