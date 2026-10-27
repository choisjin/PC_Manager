using System.Text.Json;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>
/// 프로젝트별 영상 분석 기준값을 서버에 저장한다 (그 프로젝트 사용자 모두 같은 기준으로 판정).
/// 프로젝트 하나씩 바꿔 서로 덮어쓰지 않는다
/// </summary>
public class AnalysisDefaultsStore(AppPaths paths)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    /// <summary>값 개수·이름 길이 한도 (잘못된 요청으로 파일이 커지지 않게)</summary>
    private const int MaxValues = 200;
    private const int MaxName = 64;

    private static readonly AnalysisDefaultsView Empty = new(new Dictionary<string, double>(), null, null);

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "analysis-defaults.json");

    public AnalysisDefaultsView Get(string projectId)
    {
        lock (_lock)
            return Read().GetValueOrDefault(projectId) ?? Empty;
    }

    /// <summary>프로젝트 하나의 기준값을 바꾼다 (비우면 지워 대시보드 기본값으로)</summary>
    public AnalysisDefaultsView Set(string projectId, IReadOnlyDictionary<string, double> values, string? userId)
    {
        lock (_lock)
        {
            var all = Read();
            var clean = values
                .Where(kv => kv.Key.Length is > 0 and <= MaxName && double.IsFinite(kv.Value))
                .Take(MaxValues)
                .ToDictionary(kv => kv.Key, kv => kv.Value);
            var saved = new AnalysisDefaultsView(clean, userId, DateTime.UtcNow);
            if (clean.Count == 0)
                all.Remove(projectId);
            else
                all[projectId] = saved;
            Write(all);
            return saved;
        }
    }

    private void Write(Dictionary<string, AnalysisDefaultsView> all)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var tempPath = _path + ".tmp";
        File.WriteAllText(tempPath, JsonSerializer.Serialize(all, Json));
        File.Move(tempPath, _path, overwrite: true);
    }

    private Dictionary<string, AnalysisDefaultsView> Read()
    {
        if (!File.Exists(_path))
            return [];
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, AnalysisDefaultsView>>(File.ReadAllText(_path), Json) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }
}
