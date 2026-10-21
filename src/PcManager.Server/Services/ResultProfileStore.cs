using System.Text.Json;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>PC별 결과 폴더(결과 확인 탭)를 서버에 저장한다 (모든 대시보드 공유). PC 하나씩 바꿔 서로 덮어쓰지 않는다.</summary>
public class ResultProfileStore(AppPaths paths)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "result-profiles.json");

    private static ResultProfilesView Empty() => new(new Dictionary<string, ResultProfileView>());

    public ResultProfilesView Load()
    {
        lock (_lock)
            return Read();
    }

    /// <summary>PC 하나의 결과 폴더를 바꾼다 (null이면 지운다)</summary>
    public ResultProfilesView Set(string agentId, ResultProfileView? profile, string? userId)
    {
        lock (_lock)
        {
            var profiles = new Dictionary<string, ResultProfileView>(Read().Profiles);
            if (profile is null)
                profiles.Remove(agentId);
            else
                profiles[agentId] = Normalize(profile, userId);
            var saved = new ResultProfilesView(profiles);
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            var tempPath = _path + ".tmp";
            File.WriteAllText(tempPath, JsonSerializer.Serialize(saved, Json));
            File.Move(tempPath, _path, overwrite: true);
            return saved;
        }
    }

    private ResultProfilesView Read()
    {
        if (!File.Exists(_path))
            return Empty();
        try
        {
            return JsonSerializer.Deserialize<ResultProfilesView>(File.ReadAllText(_path), Json) ?? Empty();
        }
        catch (JsonException)
        {
            return Empty();
        }
    }

    private static ResultProfileView Normalize(ResultProfileView p, string? userId)
    {
        static string? Clean(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
        return new ResultProfileView(
            p.Mode == "rfw" ? "rfw" : "ats",
            p.ResultDir.Trim(),
            Clean(p.Pattern),
            Clean(p.VideoDir),
            Clean(p.ImageDir),
            Clean(p.RefDir),
            userId,
            DateTime.UtcNow);
    }
}
