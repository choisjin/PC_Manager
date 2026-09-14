namespace PcManager.Agent;

public class AgentOptions
{
    /// <summary>서버 주소 (예: http://192.168.0.10:5063). 비어 있으면 런처에서 입력할 때까지 연결하지 않는다</summary>
    public string ServerUrl { get; set; } = "";

    /// <summary>false면 사용자가 런처에서 연결을 끊은 상태</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>서버의 Server:AgentToken과 같은 값 (서버가 토큰을 쓰지 않으면 비움)</summary>
    public string Token { get; set; } = "";

    /// <summary>대시보드에서 그룹 선택에 쓰는 태그 (예: gui-test, site:busan)</summary>
    public List<string> Tags { get; set; } = [];

    /// <summary>AgentId, 기본 작업 폴더, 결과 폴더 저장 위치</summary>
    public string DataDirectory { get; set; } = DefaultDataDirectory;

    public static string DefaultDataDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PcManager", "Agent");

    /// <summary>연결 설정 파일 (서버 주소, 연결 여부, 태그)</summary>
    public static string InstalledConfigPath => Path.Combine(DefaultDataDirectory, "agent.json");

    /// <summary>명령 결과 폴더. resultKey는 서버가 발급한 GUID(JobRunId 또는 RunId)만 허용한다</summary>
    public string GetResultDirectory(string resultKey)
    {
        if (!Guid.TryParseExact(resultKey, "N", out _))
            throw new ArgumentException("잘못된 결과 폴더 키입니다.", nameof(resultKey));
        return Path.Combine(DataDirectory, "results", resultKey);
    }
}
