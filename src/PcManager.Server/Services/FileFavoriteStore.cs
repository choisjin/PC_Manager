using System.Text.Json;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>사용자별 파일 즐겨찾기 (사이드바 PC 목록 아래). userId → 목록을 한 파일에 저장한다.</summary>
public class FileFavoriteStore(AppPaths paths)
{
    private const int MaxPerUser = 200;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "file-favorites.json");

    public FileFavoritesView Load(string userId)
    {
        lock (_lock)
            return new FileFavoritesView(LoadUnlocked().GetValueOrDefault(userId) ?? []);
    }

    public FileFavoritesView Save(string userId, IReadOnlyList<FileFavorite>? items)
    {
        var normalized = Normalize(items ?? []);
        lock (_lock)
        {
            var all = LoadUnlocked();
            if (normalized.Count > 0)
                all[userId] = normalized;
            else
                all.Remove(userId);
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            var tempPath = _path + ".tmp";
            File.WriteAllText(tempPath, JsonSerializer.Serialize(all, Json));
            File.Move(tempPath, _path, overwrite: true);
        }
        return new FileFavoritesView(normalized);
    }

    private Dictionary<string, List<FileFavorite>> LoadUnlocked()
    {
        if (!File.Exists(_path))
            return [];
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, List<FileFavorite>>>(File.ReadAllText(_path), Json) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    // 어느 PC 것인지(SourceId) 없는 항목은 버린다. 같은 PC의 같은 경로는 하나만
    private static List<FileFavorite> Normalize(IReadOnlyList<FileFavorite> items)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<FileFavorite>();
        foreach (var item in items)
        {
            if (string.IsNullOrWhiteSpace(item.SourceId) || string.IsNullOrWhiteSpace(item.Path))
                continue;
            var path = item.Path.Trim();
            if (!seen.Add($"{item.SourceId}|{path}"))
                continue;
            result.Add(item with
            {
                Id = string.IsNullOrWhiteSpace(item.Id) ? Guid.NewGuid().ToString("N") : item.Id,
                SourceName = string.IsNullOrWhiteSpace(item.SourceName) ? item.SourceId : item.SourceName.Trim(),
                Path = path,
                AddedAt = item.AddedAt == default ? DateTimeOffset.UtcNow : item.AddedAt,
            });
            if (result.Count >= MaxPerUser)
                break;
        }
        return result;
    }
}
