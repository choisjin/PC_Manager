using System.Text.Json;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>State 화면 배치(서버·그룹·사용자 위치, 고정 여부)를 서버에 저장한다 (모든 대시보드 공유). PcFavoriteStore와 같은 단순 저장소.</summary>
public class StateLayoutStore(AppPaths paths)
{
    private const int MaxPositions = 2000;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "state-layout.json");

    private static StateLayoutView Empty() => new(new Dictionary<string, StatePoint>(), false, null, null);

    public StateLayoutView Load()
    {
        lock (_lock)
        {
            if (!File.Exists(_path))
                return Empty();
            try
            {
                return JsonSerializer.Deserialize<StateLayoutView>(File.ReadAllText(_path), Json) ?? Empty();
            }
            catch (JsonException)
            {
                return Empty();
            }
        }
    }

    public StateLayoutView Save(StateLayoutView view)
    {
        var normalized = new StateLayoutView(
            (view.Positions ?? new Dictionary<string, StatePoint>())
                .Where(kv => !string.IsNullOrWhiteSpace(kv.Key) && double.IsFinite(kv.Value.X) && double.IsFinite(kv.Value.Y))
                .Take(MaxPositions)
                .ToDictionary(kv => kv.Key, kv => new StatePoint(Math.Clamp(kv.Value.X, 0, 1), Math.Clamp(kv.Value.Y, 0, 1))),
            view.Locked,
            string.IsNullOrWhiteSpace(view.UpdatedBy) ? null : view.UpdatedBy,
            DateTime.UtcNow);
        lock (_lock)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            var tempPath = _path + ".tmp";
            File.WriteAllText(tempPath, JsonSerializer.Serialize(normalized, Json));
            File.Move(tempPath, _path, overwrite: true);
        }
        return normalized;
    }
}
