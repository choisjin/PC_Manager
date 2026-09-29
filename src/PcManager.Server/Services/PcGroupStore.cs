using System.Text.Json;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>
/// PC 그룹(폴더) 구성을 서버에 저장한다 (모든 대시보드가 공유).
/// 단일 JSON 문서 전체를 읽고 쓰는 단순 저장소 (내부망·소규모 전제, last-write-wins).
/// </summary>
public class PcGroupStore(AppPaths paths)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private static readonly PcGroupsView Empty = new([], new Dictionary<string, string>());

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "pc-groups.json");

    public PcGroupsView Load()
    {
        lock (_lock)
        {
            if (!File.Exists(_path))
                return Empty;
            try
            {
                return JsonSerializer.Deserialize<PcGroupsView>(File.ReadAllText(_path), Json) ?? Empty;
            }
            catch (JsonException)
            {
                return Empty;
            }
        }
    }

    public PcGroupsView Save(PcGroupsView view)
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

    /// <summary>잘못된 참조(없는 부모/폴더)를 정리하고 크기를 제한한다.</summary>
    private static PcGroupsView Normalize(PcGroupsView view)
    {
        var folders = (view.Folders ?? [])
            .Where(f => !string.IsNullOrWhiteSpace(f.Id) && !string.IsNullOrWhiteSpace(f.Name))
            .Take(500)
            .Select(f => f with { Name = f.Name.Trim()[..Math.Min(f.Name.Trim().Length, 100)] })
            .ToList();

        var ids = folders.Select(f => f.Id).ToHashSet();
        // 없는 부모는 루트로
        folders = folders
            .Select(f => f.ParentId is not null && ids.Contains(f.ParentId) ? f : f with { ParentId = null })
            .ToList();

        // 없는 폴더로의 배치는 버린다
        var assignments = (view.Assignments ?? new Dictionary<string, string>())
            .Where(kv => ids.Contains(kv.Value))
            .ToDictionary(kv => kv.Key, kv => kv.Value);

        return new PcGroupsView(folders, assignments);
    }
}
