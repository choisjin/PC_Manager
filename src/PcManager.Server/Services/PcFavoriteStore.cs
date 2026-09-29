using System.Text.Json;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>PC별 즐겨찾기 폴더를 서버에 저장한다 (모든 대시보드 공유). PcGroupStore와 같은 단순 저장소.</summary>
public class PcFavoriteStore(AppPaths paths)
{
    private const int MaxPerAgent = 100;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "pc-favorites.json");

    public PcFavoritesView Load()
    {
        lock (_lock)
        {
            if (!File.Exists(_path))
                return new PcFavoritesView(new Dictionary<string, IReadOnlyList<string>>());
            try
            {
                return JsonSerializer.Deserialize<PcFavoritesView>(File.ReadAllText(_path), Json)
                    ?? new PcFavoritesView(new Dictionary<string, IReadOnlyList<string>>());
            }
            catch (JsonException)
            {
                return new PcFavoritesView(new Dictionary<string, IReadOnlyList<string>>());
            }
        }
    }

    public PcFavoritesView Save(PcFavoritesView view)
    {
        var normalized = Normalize(view);
        lock (_lock)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            var tempPath = _path + ".tmp";
            File.WriteAllText(tempPath, JsonSerializer.Serialize(normalized, Json));
            File.Move(tempPath, _path, overwrite: true);
        }
        return normalized;
    }

    private static PcFavoritesView Normalize(PcFavoritesView view)
    {
        var result = new Dictionary<string, IReadOnlyList<string>>();
        foreach (var (agentId, paths) in view.Favorites ?? new Dictionary<string, IReadOnlyList<string>>())
        {
            if (string.IsNullOrWhiteSpace(agentId))
                continue;
            var cleaned = (paths ?? [])
                .Where(p => !string.IsNullOrWhiteSpace(p))
                .Select(p => p.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(MaxPerAgent)
                .ToList();
            if (cleaned.Count > 0)
                result[agentId] = cleaned;
        }
        return new PcFavoritesView(result);
    }
}
