namespace PcManager.Agent.Service;

public class AgentOptions
{
    public string ServerUrl { get; set; } = "http://localhost:5063";

    /// <summary>서버의 Server:AgentToken과 같은 값</summary>
    public string Token { get; set; } = "";

    /// <summary>대시보드에서 그룹 선택에 쓰는 태그 (예: gui-test, site:busan)</summary>
    public List<string> Tags { get; set; } = [];

    /// <summary>AgentId, 기본 작업 폴더 저장 위치</summary>
    public string DataDirectory { get; set; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PcManager", "Agent");

    /// <summary>설치 스크립트가 만드는 설정 파일 위치 (서버 주소, 토큰, 태그)</summary>
    public static string InstalledConfigPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PcManager", "Agent", "agent.json");

    /// <summary>명령 결과 폴더. resultKey는 서버가 발급한 GUID(JobRunId 또는 RunId)만 허용한다</summary>
    public string GetResultDirectory(string resultKey)
    {
        if (!Guid.TryParseExact(resultKey, "N", out _))
            throw new ArgumentException("잘못된 결과 폴더 키입니다.", nameof(resultKey));
        return Path.Combine(DataDirectory, "results", resultKey);
    }
}
