using System.Text.Json;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>공개 다운로드 링크(토큰 → 파일)를 저장한다.</summary>
public class DownloadLinkStore(AppPaths paths)
{
    private const int MaxLinks = 2000;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "download-links.json");

    private List<DownloadLink> LoadUnlocked()
    {
        if (!File.Exists(_path))
            return [];
        try
        {
            return JsonSerializer.Deserialize<List<DownloadLink>>(File.ReadAllText(_path), Json) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    public DownloadLink Create(string agentId, string path)
    {
        var name = Path.GetFileName(path.TrimEnd('\\', '/'));
        if (string.IsNullOrEmpty(name))
            name = "download";
        var link = new DownloadLink(Guid.NewGuid().ToString("N"), agentId, path, name, DateTime.UtcNow);
        lock (_lock)
        {
            var list = LoadUnlocked();
            // 같은 파일에 대한 링크가 이미 있으면 재사용
            var existing = list.FirstOrDefault(l => l.AgentId == agentId && string.Equals(l.Path, path, StringComparison.OrdinalIgnoreCase));
            if (existing is not null)
                return existing;
            list.Add(link);
            if (list.Count > MaxLinks)
                list = list.OrderByDescending(l => l.CreatedAt).Take(MaxLinks).ToList();
            Save(list);
        }
        return link;
    }

    public bool TryGet(string token, out DownloadLink link)
    {
        lock (_lock)
        {
            link = LoadUnlocked().FirstOrDefault(l => l.Token == token)!;
            return link is not null;
        }
    }

    private void Save(List<DownloadLink> list)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var temp = _path + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(list, Json));
        File.Move(temp, _path, overwrite: true);
    }
}
