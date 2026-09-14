using System.Text.Json;
using Microsoft.Extensions.Options;

namespace PcManager.Agent;

/// <summary>런처에서 바꿀 수 있는 연결 설정</summary>
public record AgentSettings(string ServerUrl, bool Enabled, IReadOnlyList<string> Tags, string Token)
{
    public bool HasServer => Uri.TryCreate(ServerUrl, UriKind.Absolute, out var uri)
        && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);
}

/// <summary>
/// 연결 설정을 %ProgramData%\PcManager\Agent\agent.json에 저장하고, 바뀌면 대기자에게 알린다.
/// 서비스가 실행 중에도 설정을 바꿀 수 있어 IOptions 대신 이 저장소를 쓴다.
/// </summary>
public class AgentSettingsStore
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    private readonly Lock _lock = new();
    private AgentSettings _current;
    private TaskCompletionSource _changed = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public AgentSettingsStore(IOptions<AgentOptions> options)
    {
        // 시작 시 값은 설정 시스템(agent.json + 개발용 appsettings)에서 읽는다
        var o = options.Value;
        _current = new AgentSettings(o.ServerUrl, o.Enabled, o.Tags, o.Token);
    }

    public AgentSettings Current
    {
        get { lock (_lock) return _current; }
    }

    /// <summary>다음 설정 변경 때 완료되는 Task</summary>
    public Task WhenChanged
    {
        get { lock (_lock) return _changed.Task; }
    }

    public void Save(AgentSettings settings)
    {
        var path = AgentOptions.InstalledConfigPath;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var document = new
        {
            Agent = new { settings.ServerUrl, settings.Enabled, settings.Tags, settings.Token },
        };

        // 쓰는 도중 서비스가 죽어도 파일이 깨지지 않게 임시 파일에 쓰고 교체한다
        var tempPath = path + ".tmp";
        File.WriteAllText(tempPath, JsonSerializer.Serialize(document, Json));
        File.Move(tempPath, path, overwrite: true);

        TaskCompletionSource previous;
        lock (_lock)
        {
            _current = settings;
            previous = _changed;
            _changed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        }
        previous.TrySetResult();
    }
}
