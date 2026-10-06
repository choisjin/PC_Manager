using System.Text.Json;
using System.Text.Json.Serialization;

namespace PcManager.Server.Services;

/// <summary>결과 확인 도구의 백업 상태. Skipped: 테스트 PC에 없는 파일 (Result에 적혔지만 다른 PC 경로 등 — 실패로 보지 않음)</summary>
public record ResultSetBackup(string State, int FilesDone, int FilesTotal, long BytesDone, string? Error, int Skipped = 0)
{
    public static ResultSetBackup Pending(int total) => new("running", 0, total, 0, null);
}

/// <summary>
/// 결과 확인 '셋': 어느 PC의 어떤 Result·영상·이미지를 어떻게 맞춰 봤는지(Config)와 서버에 백업한 파일 목록.
/// Requested: 백업하려는 원래 경로(테스트 PC) 목록, Files: 받은 것 → 백업 파일 이름. 백업된 파일은 테스트 PC가 꺼져 있어도 열린다
/// </summary>
public record ResultSet(
    string Id,
    string Name,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    string? CreatedBy,
    string AgentId,
    string? MachineName,
    string ResultPath,
    IReadOnlyList<string> VideoPaths,
    string? ImageDir,
    bool CopyVideo,
    JsonElement? Config,
    IReadOnlyList<string> Requested,
    IReadOnlyDictionary<string, string> Files,
    ResultSetBackup Backup);

/// <summary>목록용 요약 (Config·파일 목록 제외)</summary>
public record ResultSetSummary(
    string Id, string Name, DateTime CreatedAt, DateTime UpdatedAt, string? CreatedBy,
    string AgentId, string? MachineName, string ResultPath, int VideoCount, bool CopyVideo, ResultSetBackup Backup);

/// <summary>셋 저장소: {데이터 폴더}/result-sets/{id}/set.json + files/</summary>
public class ResultSetStore(AppPaths paths)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly Lock _lock = new();
    private string Root => Path.Combine(paths.DataDirectory, "result-sets");

    public string FilesDirectory(string id) => Path.Combine(Root, Safe(id), "files");

    public IReadOnlyList<ResultSetSummary> List()
    {
        if (!Directory.Exists(Root))
            return [];
        return Directory.GetDirectories(Root)
            .Select(d => Get(Path.GetFileName(d)))
            .OfType<ResultSet>()
            .OrderByDescending(s => s.UpdatedAt)
            .Select(s => new ResultSetSummary(s.Id, s.Name, s.CreatedAt, s.UpdatedAt, s.CreatedBy, s.AgentId, s.MachineName,
                s.ResultPath, s.VideoPaths.Count, s.CopyVideo, s.Backup))
            .ToList();
    }

    public ResultSet? Get(string id)
    {
        var file = Path.Combine(Root, Safe(id), "set.json");
        lock (_lock)
        {
            try
            {
                return File.Exists(file) ? JsonSerializer.Deserialize<ResultSet>(File.ReadAllText(file), Json) : null;
            }
            catch (JsonException)
            {
                return null;
            }
        }
    }

    public void Save(ResultSet set)
    {
        var dir = Path.Combine(Root, Safe(set.Id));
        Directory.CreateDirectory(dir);
        var file = Path.Combine(dir, "set.json");
        lock (_lock)
        {
            var temp = file + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(set, Json));
            File.Move(temp, file, overwrite: true);
        }
    }

    /// <summary>현재 저장본을 읽어 바꾼 뒤 저장 (백업 진행과 이름 변경이 겹쳐도 서로 덮어쓰지 않게)</summary>
    public ResultSet? Update(string id, Func<ResultSet, ResultSet> change)
    {
        lock (_lock)
        {
            var current = Get(id);
            if (current is null)
                return null;
            var next = change(current);
            Save(next);
            return next;
        }
    }

    public bool Delete(string id)
    {
        var dir = Path.Combine(Root, Safe(id));
        if (!Directory.Exists(dir))
            return false;
        Directory.Delete(dir, recursive: true);
        return true;
    }

    /// <summary>셋 id는 서버가 만든 GUID만 (경로 조작 방지)</summary>
    private static string Safe(string id) =>
        Guid.TryParseExact(id, "N", out _) ? id : throw new ArgumentException("잘못된 셋 ID입니다.");
}
