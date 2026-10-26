using System.Text.Json;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>결과 확인 예약 분석 목록을 서버에 저장한다 (모든 대시보드가 본다). 시각이 되면 ResultScheduler가 시작한다</summary>
public class ResultScheduleStore(AppPaths paths)
{
    private const int MaxSchedules = 100;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public sealed class Stored
    {
        public required ResultScheduleView View { get; set; }
        public required CreateResultScheduleRequest Request { get; set; }
    }

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "result-schedules.json");
    private List<Stored>? _cache;

    /// <summary>시각순</summary>
    public IReadOnlyList<ResultScheduleView> List()
    {
        lock (_lock)
            return Cache().Select(s => s.View).OrderBy(v => v.At).ToList();
    }

    /// <summary>시작할 때가 된 예약</summary>
    public IReadOnlyList<Stored> Due(DateTime now)
    {
        lock (_lock)
            return Cache().Where(s => s.View.State == "pending" && s.View.At <= now).ToList();
    }

    public ResultScheduleView Add(CreateResultScheduleRequest r, string? userId)
    {
        var view = new ResultScheduleView(Guid.NewGuid().ToString("N"), r.AgentId, r.MachineName, r.Title, r.SourceKey, userId,
            r.At.ToUniversalTime(), r.Videos, r.Analysis is not null, r.Search is not null, "pending", null, DateTime.UtcNow, null, null);
        lock (_lock)
        {
            var cache = Cache();
            cache.Add(new Stored { View = view, Request = r });
            // 오래된 끝난 예약부터 버린다
            while (cache.Count > MaxSchedules)
            {
                var old = cache.Where(s => s.View.State != "pending").MinBy(s => s.View.Created);
                if (old is null)
                    break;
                cache.Remove(old);
            }
            Persist(cache);
        }
        return view;
    }

    public void Update(string id, Func<ResultScheduleView, ResultScheduleView> change)
    {
        lock (_lock)
        {
            var cache = Cache();
            if (cache.FirstOrDefault(s => s.View.Id == id) is not { } stored)
                return;
            stored.View = change(stored.View);
            Persist(cache);
        }
    }

    public bool Remove(string id)
    {
        lock (_lock)
        {
            var cache = Cache();
            if (cache.RemoveAll(s => s.View.Id == id) == 0)
                return false;
            Persist(cache);
            return true;
        }
    }

    private List<Stored> Cache()
    {
        if (_cache is not null)
            return _cache;
        try
        {
            _cache = File.Exists(_path) ? JsonSerializer.Deserialize<List<Stored>>(File.ReadAllText(_path), Json) ?? [] : [];
        }
        catch (JsonException)
        {
            _cache = [];
        }
        return _cache;
    }

    private void Persist(List<Stored> cache)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var tempPath = _path + ".tmp";
        File.WriteAllText(tempPath, JsonSerializer.Serialize(cache, Json));
        File.Move(tempPath, _path, overwrite: true);
    }
}
