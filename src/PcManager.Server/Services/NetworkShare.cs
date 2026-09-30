using System.Runtime.InteropServices;

namespace PcManager.Server.Services;

/// <summary>네트워크 공유(UNC)에 자격증명으로 연결한다 (Windows WNetAddConnection2).</summary>
public static class NetworkShare
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NetResource
    {
        public int Scope;
        public int Type;
        public int DisplayType;
        public int Usage;
        public string? LocalName;
        public string RemoteName;
        public string? Comment;
        public string? Provider;
    }

    [DllImport("mpr.dll", CharSet = CharSet.Unicode)]
    private static extern int WNetAddConnection2(ref NetResource netResource, string? password, string? username, int flags);

    private const int ResourceTypeDisk = 1;
    private const int ErrorSessionCredentialConflict = 1219;

    /// <summary>UNC 경로에서 공유 루트(\\서버\공유)를 뽑는다.</summary>
    public static string ShareRoot(string path)
    {
        if (!path.StartsWith(@"\\", StringComparison.Ordinal))
            return path;
        var parts = path.TrimStart('\\').Split('\\', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length >= 2 ? $@"\\{parts[0]}\{parts[1]}" : path;
    }

    /// <summary>공유 서버에 자격증명으로 로그온한다. 이후 이 프로세스는 해당 공유에 접근할 수 있다.</summary>
    public static void Connect(string path, string username, string password)
    {
        var remote = ShareRoot(path);
        var resource = new NetResource { Type = ResourceTypeDisk, RemoteName = remote };
        var result = WNetAddConnection2(ref resource, password, username, 0);
        // 0=성공, 1219=이미 다른 자격증명으로 연결됨(그대로 진행해 접근 가능 여부로 판단)
        if (result != 0 && result != ErrorSessionCredentialConflict)
            throw new IOException($"공유 서버 인증 실패 (코드 {result}). 사용자 이름/비밀번호 또는 경로를 확인하세요.");
    }
}
