using System.Text.Json;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>서버가 직접 접근하는 공유 폴더 목록을 저장한다 (모든 대시보드 공유).</summary>
public class SharedFolderStore(AppPaths paths)
{
    private const int MaxShares = 100;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "shared-folders.json");

    public SharedFoldersView Load()
    {
        lock (_lock)
        {
            return LoadUnlocked();
        }
    }

    private SharedFoldersView LoadUnlocked()
    {
        if (!File.Exists(_path))
            return new SharedFoldersView([]);
        try
        {
            return JsonSerializer.Deserialize<SharedFoldersView>(File.ReadAllText(_path), Json)
                ?? new SharedFoldersView([]);
        }
        catch (JsonException)
        {
            return new SharedFoldersView([]);
        }
    }

    public bool TryGet(string id, out SharedFolder share)
    {
        share = Load().Shares.FirstOrDefault(s => s.Id == id)!;
        return share is not null;
    }

    /// <summary>공유 폴더 추가. 경로가 실제로 접근 가능해야 한다.</summary>
    public SharedFolder Add(string name, string path)
    {
        var cleanPath = path.Trim().TrimEnd('\\', '/');
        if (string.IsNullOrWhiteSpace(cleanPath))
            throw new ArgumentException("경로를 입력하세요.");
        if (!Directory.Exists(cleanPath))
            throw new DirectoryNotFoundException($"폴더에 접근할 수 없습니다: {cleanPath}");

        var cleanName = string.IsNullOrWhiteSpace(name)
            ? (Path.GetFileName(cleanPath) is { Length: > 0 } leaf ? leaf : cleanPath)
            : name.Trim();

        var share = new SharedFolder(Guid.NewGuid().ToString("N"), cleanName, cleanPath);
        lock (_lock)
        {
            var current = LoadUnlocked().Shares.ToList();
            if (current.Count >= MaxShares)
                throw new InvalidOperationException("공유 폴더가 너무 많습니다.");
            // 같은 경로가 이미 있으면 그대로 반환
            var existing = current.FirstOrDefault(s => string.Equals(s.Path, cleanPath, StringComparison.OrdinalIgnoreCase));
            if (existing is not null)
                return existing;
            current.Add(share);
            SaveUnlocked(current);
        }
        return share;
    }

    public SharedFoldersView Remove(string id)
    {
        lock (_lock)
        {
            var current = LoadUnlocked().Shares.Where(s => s.Id != id).ToList();
            SaveUnlocked(current);
            return new SharedFoldersView(current);
        }
    }

    private void SaveUnlocked(IReadOnlyList<SharedFolder> shares)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var tempPath = _path + ".tmp";
        File.WriteAllText(tempPath, JsonSerializer.Serialize(new SharedFoldersView(shares), Json));
        File.Move(tempPath, _path, overwrite: true);
    }
}
