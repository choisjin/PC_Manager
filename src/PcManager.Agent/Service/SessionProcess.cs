using System.ComponentModel;
using System.Diagnostics;
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

    /// <summary>이 세션이 원격 데스크톱(RDP)으로 연결돼 있는지. 물리 콘솔·직접 로그인은 false</summary>
    public static bool IsRemoteSession(int sessionId)
    {
        if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, WTSClientProtocolType, out var buffer, out var bytes))
            return false;
        try
        {
            // 0: 콘솔, 2: RDP
            return bytes >= 2 && Marshal.ReadInt16(buffer) == 2;
        }
        finally
        {
            WTSFreeMemory(buffer);
        }
    }

    /// <summary>
    /// RDP로 연결된 세션을 물리 콘솔로 옮긴다. RDP 클라이언트 연결은 끊기고, 그 세션이 콘솔에 표시된다
    /// (앱·로그인 상태 유지). 원격조작이 RDP보다 우선하도록, SYSTEM 서비스에서 tscon으로 수행한다.
    /// </summary>
    /// <returns>성공 여부</returns>
    public static bool ConnectSessionToConsole(int sessionId)
    {
        var tscon = Path.Combine(Environment.SystemDirectory, "tscon.exe");
        if (!File.Exists(tscon))
            return false;

        var start = new ProcessStartInfo(tscon)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(sessionId.ToString());
        start.ArgumentList.Add("/dest:console");

        using var process = Process.Start(start);
        if (process is null)
            return false;
        process.WaitForExit(5000);
        return process.HasExited && process.ExitCode == 0;
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

    private const int WTSClientProtocolType = 16;

    [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool WTSQuerySessionInformation(IntPtr hServer, int sessionId, int infoClass, out IntPtr ppBuffer, out int pBytesReturned);

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

    /// <summary>사용자가 지금 쓰는 세션 (콘솔 우선, 없으면 첫 활성 세션). 로그인 전이면 null</summary>
    public static int? GetInteractiveUserSessionId()
    {
        var active = GetActiveSessionIds();
        if (active.Count == 0)
            return null;
        return GetConsoleSessionId() is { } c && active.Contains(c) ? c : active[0];
    }

    /// <summary>세션 사용자의 '문서' 폴더 (OneDrive로 옮겨 둔 경우도 그 위치). SYSTEM 계정에서만 동작한다.</summary>
    public static string GetUserDocumentsFolder(int sessionId)
    {
        if (!WTSQueryUserToken(sessionId, out var userToken))
            throw new Win32Exception();
        try
        {
            var documents = new Guid("FDD39AD0-238F-46AF-ADB4-6C85480369C7");
            var hr = SHGetKnownFolderPath(documents, 0, userToken, out var pathPtr);
            if (hr != 0)
                throw new Win32Exception(hr);
            try
            {
                return Marshal.PtrToStringUni(pathPtr)!;
            }
            finally
            {
                Marshal.FreeCoTaskMem(pathPtr);
            }
        }
        finally
        {
            CloseHandle(userToken);
        }
    }

    [DllImport("shell32.dll")]
    private static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid folderId, uint flags, IntPtr token, out IntPtr path);
}
