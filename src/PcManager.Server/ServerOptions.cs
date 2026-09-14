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

    /// <summary>설치 스크립트가 만드는 설정 파일 위치</summary>
    public static string InstalledConfigPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PcManager", "Server", "server.json");
}

public record AppPaths(string DataDirectory)
{
    public string RunsDirectory => Path.Combine(DataDirectory, "runs");
}
