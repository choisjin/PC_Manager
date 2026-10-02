using System.Runtime.InteropServices;

namespace PcManager.Server.Services;

/// <summary>
/// "\\서버"(공유 폴더 이름 없이 서버만)를 탐색기처럼 다룬다: 그 서버의 공유 폴더 목록을 꺼낸다 (NetShareEnum).
/// 현재 스레드가 가장한 자격증명으로 접속하므로 공유 폴더 자격증명과 함께 쓸 수 있다.
/// </summary>
public static class NetworkShares
{
    /// <summary>"\\서버" 처럼 서버 이름만 있는 경로인지</summary>
    public static bool IsServerRoot(string path)
    {
        var p = path.Trim().TrimEnd('\\', '/');
        return p.StartsWith(@"\\", StringComparison.Ordinal)
            && p.Length > 2
            && p[2..].Split('\\', StringSplitOptions.RemoveEmptyEntries).Length == 1;
    }

    /// <summary>서버의 일반 디스크 공유 이름 (관리용 C$·IPC$ 등 숨김 공유 제외)</summary>
    /// <returns>Win32 오류 코드. 0이면 성공</returns>
    public static int TryList(string serverRoot, out List<string> shares)
    {
        shares = [];
        var server = serverRoot.Trim().TrimEnd('\\', '/');
        var result = NetShareEnum(server, 1, out var buffer, MaxPreferredLength, out var read, out _, IntPtr.Zero);
        try
        {
            if (result != 0)
                return result;
            var size = Marshal.SizeOf<SHARE_INFO_1>();
            for (var i = 0; i < read; i++)
            {
                var info = Marshal.PtrToStructure<SHARE_INFO_1>(buffer + i * size);
                var isDisk = (info.shi1_type & 0xFF) == StypeDiskTree;
                var isSpecial = (info.shi1_type & StypeSpecial) != 0;
                if (isDisk && !isSpecial && !string.IsNullOrEmpty(info.shi1_netname) && !info.shi1_netname.EndsWith('$'))
                    shares.Add(info.shi1_netname);
            }
            shares.Sort(StringComparer.OrdinalIgnoreCase);
            return 0;
        }
        finally
        {
            if (buffer != IntPtr.Zero)
                NetApiBufferFree(buffer);
        }
    }

    /// <summary>오류 코드가 권한 문제(자격증명으로 해결 가능)인지</summary>
    public static bool IsAccessError(int code) =>
        code is 5 or 86 or 1219 or 1326 or 1327 or 1330 or 1331 or 1385 or 1907 or 1909 or 2242;

    private const int MaxPreferredLength = -1;
    private const uint StypeDiskTree = 0;
    private const uint StypeSpecial = 0x80000000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHARE_INFO_1
    {
        public string shi1_netname;
        public uint shi1_type;
        public string shi1_remark;
    }

    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern int NetShareEnum(string serverName, int level, out IntPtr bufPtr, int prefMaxLen, out int entriesRead, out int totalEntries, IntPtr resumeHandle);

    [DllImport("netapi32.dll")]
    private static extern int NetApiBufferFree(IntPtr buffer);
}
