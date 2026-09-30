namespace PcManager.Agent;

/// <summary>서버 연결 상태. 워커가 갱신하고, 런처 요청에 응답할 때 읽는다.</summary>
public class AgentStatusTracker
{
    public static Version AgentVersion { get; } = ToThreeParts(typeof(AgentStatusTracker).Assembly.GetName().Version);

    public static string AgentVersionText => AgentVersion.ToString(3);

    private readonly Lock _lock = new();
    private ConnectionStatus _status = ConnectionStatus.NotConfigured;
    private string? _lastError;
    private string? _serverVersion;
    private string? _dashboardUrl;
    private bool _updating;

    /// <param name="error">표시할 오류. null이면 지운다</param>
    public void SetStatus(ConnectionStatus status, string? error = null)
    {
        lock (_lock)
        {
            _status = status;
            _lastError = error;
        }
    }

    /// <param name="dashboardUrl">대시보드 HTTPS 주소. null이면 런처가 서버 주소(HTTP)로 연다</param>
    public void SetServerInfo(string? version, string? dashboardUrl)
    {
        lock (_lock)
        {
            _serverVersion = version;
            _dashboardUrl = dashboardUrl;
        }
    }

    public void SetUpdating(bool updating)
    {
        lock (_lock)
            _updating = updating;
    }

    public LocalStatus Snapshot(AgentSettings settings)
    {
        lock (_lock)
        {
            var updateAvailable = Version.TryParse(_serverVersion, out var server) && ToThreeParts(server) > AgentVersion;
            return new LocalStatus(
                _status, settings.ServerUrl, Environment.MachineName, AgentVersionText,
                _serverVersion, updateAvailable, _updating, _lastError, _dashboardUrl);
        }
    }

    private static Version ToThreeParts(Version? version) =>
        version is null ? new Version(0, 0, 0) : new Version(version.Major, version.Minor, Math.Max(version.Build, 0));
}
