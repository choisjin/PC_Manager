namespace PcManager.Server;

public class ServerOptions
{
    /// <summary>에이전트 등록 토큰 (선택). 비우면 인증 없이 서버 주소만으로 에이전트가 연결된다</summary>
    public string AgentToken { get; set; } = "";

    /// <summary>DB, 실행 로그, 결과 파일 저장 폴더 (ContentRoot 기준 상대 경로 허용)</summary>
    /// <remarks>Windows는 대소문자를 구분하지 않아 소스 폴더 Data/와 겹치지 않는 이름을 쓴다</remarks>
    public string DataDirectory { get; set; } = "App_Data";

    /// <summary>에이전트가 접속할 서버 주소 (예: http://192.168.0.10:5063). 비우면 대시보드 요청 주소를 쓴다</summary>
    public string? PublicUrl { get; set; }

    /// <summary>대시보드 HTTPS 주소 (예: https://192.168.0.10:5064). 설치 스크립트가 자체 서명 인증서와 함께 설정한다</summary>
    public string? DashboardHttpsUrl { get; set; }

    /// <summary>업데이트 확인에 쓰는 GitHub 저장소 (owner/repo)</summary>
    public string UpdateRepo { get; set; } = "choisjin/PC_Manager";

    /// <summary>
    /// GitHub 토큰 (선택). 넣으면 API 요청 한도가 IP당 시간 60회 → 5000회로 늘어난다.
    /// 없어도 API가 막히면 웹 주소로 최신 버전을 확인한다 (릴리스 노트만 못 받음)
    /// </summary>
    public string? GitHubToken { get; set; }

    /// <summary>업데이트 자동 확인 주기(분). 0이면 자동 확인 안 함(수동 확인만)</summary>
    public int UpdateCheckIntervalMinutes { get; set; } = 180;

    /// <summary>--port로 띄운 포터블 실행 (설정 파일이 아니라 실행 인자로 정해짐). 서버 자가 업데이트는 하지 않는다</summary>
    public bool Portable { get; set; }

    /// <summary>설치 스크립트가 만드는 설정 파일 위치</summary>
    public static string InstalledConfigPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PcManager", "Server", "server.json");
}

/// <summary>실행 인자 해석 (--name 값 / --name=값)</summary>
public static class ServerArgs
{
    public static string? Value(string[] args, string name)
    {
        for (var i = 0; i < args.Length; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                return i + 1 < args.Length ? args[i + 1] : null;
            if (args[i].StartsWith(name + "=", StringComparison.OrdinalIgnoreCase))
                return args[i][(name.Length + 1)..];
        }
        return null;
    }

    /// <summary>--port 값. 없으면 null, 잘못된 값이면 시작하지 않는다</summary>
    public static int? Port(string[] args)
    {
        var raw = Value(args, "--port");
        if (raw is null)
            return null;
        if (!int.TryParse(raw, out var port) || port is < 1 or > 65535)
            throw new ArgumentException($"--port 값이 올바르지 않습니다: {raw} (1~65535)");
        return port;
    }
}

public record AppPaths(string DataDirectory)
{
    public string RunsDirectory => Path.Combine(DataDirectory, "runs");
}
