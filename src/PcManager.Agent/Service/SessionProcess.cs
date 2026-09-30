using System.ComponentModel;
using System.Runtime.InteropServices;

namespace PcManager.Agent.Service;

/// <summary>
/// SYSTEM 서비스에서 로그인한 사용자 세션에 프로세스를 띄운다 (Session 0 격리 우회).
/// 트레이 런처와, 이후 화면 캡처/입력 잠금을 맡을 세션 에이전트 실행에 쓴다.
/// </summary>
internal static class SessionProcess
{
    /// <summary>사용자가 로그인해 있는 활성 세션 ID (원격 데스크톱 포함)</summary>
    public static List<int> GetActiveSessionIds()
    {
        var result = new List<int>();
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out var buffer, out var count))
            throw new Win32Exception();

        try
        {
            var size = Marshal.SizeOf<WTS_SESSION_INFO>();
            for (var i = 0; i < count; i++)
            {
                var info = Marshal.PtrToStructure<WTS_SESSION_INFO>(buffer + i * size);
                if (info.State == WTS_CONNECTSTATE_CLASS.WTSActive && info.SessionId != 0)
                    result.Add(info.SessionId);
            }
        }
        finally
        {
            WTSFreeMemory(buffer);
        }
        return result;
    }

    /// <summary>세션의 로그인 사용자 권한으로 프로세스를 시작한다. SYSTEM 계정에서만 동작한다.</summary>
    public static void StartAsSessionUser(int sessionId, string exePath, string arguments)
    {
        if (!WTSQueryUserToken(sessionId, out var userToken))
            throw new Win32Exception();

        var primaryToken = IntPtr.Zero;
        var environment = IntPtr.Zero;
        try
        {
            if (!DuplicateTokenEx(userToken, MAXIMUM_ALLOWED, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out primaryToken))
                throw new Win32Exception();
            if (!CreateEnvironmentBlock(out environment, primaryToken, false))
                throw new Win32Exception();

            var startup = new STARTUPINFO
            {
                cb = Marshal.SizeOf<STARTUPINFO>(),
                lpDesktop = @"winsta0\default",
            };
            var commandLine = $"\"{exePath}\" {arguments}";
            if (!CreateProcessAsUser(primaryToken, null, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                    CREATE_UNICODE_ENVIRONMENT, environment, Path.GetDirectoryName(exePath), ref startup, out var process))
            {
                throw new Win32Exception();
            }
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
        }
        finally
        {
            if (environment != IntPtr.Zero)
                DestroyEnvironmentBlock(environment);
            if (primaryToken != IntPtr.Zero)
                CloseHandle(primaryToken);
            CloseHandle(userToken);
        }
    }

    /// <summary>물리 콘솔(모니터가 연결된) 세션 ID. 로그인 전이라도 로그인 화면 세션이 있다. 없으면 null</summary>
    public static int? GetConsoleSessionId()
    {
        var id = WTSGetActiveConsoleSessionId();
        return id == uint.MaxValue ? null : (int)id;
    }

    /// <summary>
    /// 서비스 자신의 SYSTEM 토큰을 복제해 지정 세션에서 프로세스를 시작한다.
    /// 사용자 권한과 달리 UAC 확인 창·잠금/로그인 화면(Winlogon 데스크톱)까지 캡처/조작할 수 있다. 원격조작 세션용
    /// </summary>
    /// <returns>프로세스 ID</returns>
    public static int StartAsSystemInSession(int sessionId, string exePath, string arguments)
    {
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, out var selfToken))
            throw new Win32Exception();

        var primaryToken = IntPtr.Zero;
        var environment = IntPtr.Zero;
        try
        {
            if (!DuplicateTokenEx(selfToken, MAXIMUM_ALLOWED, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out primaryToken))
                throw new Win32Exception();
            if (!SetTokenInformation(primaryToken, TokenSessionId, ref sessionId, sizeof(int)))
                throw new Win32Exception();
            if (!CreateEnvironmentBlock(out environment, primaryToken, false))
                throw new Win32Exception();

            var startup = new STARTUPINFO
            {
                cb = Marshal.SizeOf<STARTUPINFO>(),
                lpDesktop = @"winsta0\default",
            };
            var commandLine = $"\"{exePath}\" {arguments}";
            if (!CreateProcessAsUser(primaryToken, null, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                    CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, environment, Path.GetDirectoryName(exePath), ref startup, out var process))
            {
                throw new Win32Exception();
            }
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
            return process.dwProcessId;
        }
        finally
        {
            if (environment != IntPtr.Zero)
                DestroyEnvironmentBlock(environment);
            if (primaryToken != IntPtr.Zero)
                CloseHandle(primaryToken);
            CloseHandle(selfToken);
        }
    }

    private const uint TOKEN_ALL_ACCESS = 0x000F01FF;
    private const int TokenSessionId = 12;
    private const uint CREATE_NO_WINDOW = 0x08000000;

    private const uint MAXIMUM_ALLOWED = 0x02000000;
    private const int SecurityImpersonation = 2;
    private const int TokenPrimary = 1;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

    private enum WTS_CONNECTSTATE_CLASS
    {
        WTSActive,
        WTSConnected,
        WTSConnectQuery,
        WTSShadow,
        WTSDisconnected,
        WTSIdle,
        WTSListen,
        WTSReset,
        WTSDown,
        WTSInit,
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WTS_SESSION_INFO
    {
        public int SessionId;
        public IntPtr pWinStationName;
        public WTS_CONNECTSTATE_CLASS State;
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

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSEnumerateSessions(IntPtr hServer, int reserved, int version, out IntPtr ppSessionInfo, out int pCount);

    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr memory);

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQueryUserToken(int sessionId, out IntPtr phToken);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateTokenEx(IntPtr hExistingToken, uint dwDesiredAccess, IntPtr lpTokenAttributes,
        int impersonationLevel, int tokenType, out IntPtr phNewToken);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(IntPtr hToken, string? lpApplicationName, string lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags,
        IntPtr lpEnvironment, string? lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(IntPtr token, int infoClass, ref int info, int length);
}
