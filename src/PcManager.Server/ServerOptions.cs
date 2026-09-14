namespace PcManager.Server;

public class ServerOptions
{
    /// <summary>에이전트가 접속할 때 보내야 하는 등록 토큰</summary>
    public string AgentToken { get; set; } = "";

    /// <summary>DB, 실행 로그, 결과 파일 저장 폴더 (ContentRoot 기준 상대 경로 허용)</summary>
    /// <remarks>Windows는 대소문자를 구분하지 않아 소스 폴더 Data/와 겹치지 않는 이름을 쓴다</remarks>
    public string DataDirectory { get; set; } = "App_Data";
}

public record AppPaths(string DataDirectory)
{
    public string RunsDirectory => Path.Combine(DataDirectory, "runs");
}
