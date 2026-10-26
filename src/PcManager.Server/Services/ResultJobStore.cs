using System.Text.Json;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>
/// 결과 확인 작업(영상 분석·이미지 찾기) 목록을 서버에 저장한다 (모든 대시보드가 본다).
/// 진행은 ResultJobPoller가 에이전트에 물어 채운다. 다시 열 때 되살릴 웹 설정(Params)은 목록과 따로 준다 (크롭 이미지 등이 커서)
/// </summary>
public class ResultJobStore(AppPaths paths)
{
    private const int MaxJobs = 100;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private sealed class Stored
    {
        public required ResultJobView View { get; set; }
        public JsonElement? Params { get; set; }
    }

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "result-jobs.json");
    private List<Stored>? _cache;

    /// <summary>새로 시작한 것부터</summary>
    public IReadOnlyList<ResultJobView> List()
    {
        lock (_lock)
            return Cache().Select(s => s.View).ToList();
    }

    public IReadOnlyList<ResultJobView> Running()
    {
        lock (_lock)
            return Cache().Where(s => s.View.State == "running").Select(s => s.View).ToList();
    }

    public ResultJobView? Get(string id)
    {
        lock (_lock)
            return Cache().FirstOrDefault(s => s.View.Id == id)?.View;
    }

    public ResultJobView Register(RegisterResultJobRequest r, string? userId)
    {
        var view = new ResultJobView(r.Id, r.Kind, r.AgentId, r.MachineName, r.Title, r.SourceKey, userId, r.Open,
            "running", 0, null, null, DateTime.UtcNow, null, false);
        lock (_lock)
        {
            var cache = Cache();
            cache.RemoveAll(s => s.View.Id == r.Id);
            cache.Insert(0, new Stored { View = view, Params = r.Params });
            // 오래된 끝난 작업부터 버린다
            while (cache.Count > MaxJobs)
            {
                var last = cache.FindLastIndex(s => s.View.State != "running");
                if (last < 0)
                    break;
                cache.RemoveAt(last);
            }
            Persist(cache);
        }
        return view;
    }

    public JsonElement? GetParams(string id)
    {
        lock (_lock)
            return Cache().FirstOrDefault(s => s.View.Id == id)?.Params;
    }

    public bool SetParams(string id, JsonElement value)
    {
        lock (_lock)
        {
            var cache = Cache();
            if (cache.FirstOrDefault(s => s.View.Id == id) is not { } stored)
                return false;
            stored.Params = value;
            Persist(cache);
            return true;
        }
    }

    /// <summary>진행·상태를 바꾼다. 바뀐 게 있으면 true (진행은 1% 넘게 바뀔 때만 — 너무 자주 알리지 않게)</summary>
    public bool Update(string id, string state, double progress, string? current, string? error)
    {
        lock (_lock)
        {
            var cache = Cache();
            if (cache.FirstOrDefault(s => s.View.Id == id) is not { } stored)
                return false;
            var v = stored.View;
            if (v.State == state && Math.Abs(v.Progress - progress) < 0.01 && v.Current == current && v.Error == error)
                return false;
            var finished = state != "running" && v.State == "running" ? DateTime.UtcNow : v.Finished;
            stored.View = v with { State = state, Progress = progress, Current = current, Error = error, Finished = finished };
            // 진행만 바뀐 것은 파일에 쓰지 않는다 (상태가 바뀔 때 함께 저장)
            if (v.State != state || v.Error != error)
                Persist(cache);
            return true;
        }
    }

    public bool MarkSeen(string id)
    {
        lock (_lock)
        {
            var cache = Cache();
            if (cache.FirstOrDefault(s => s.View.Id == id) is not { } stored || stored.View.Seen)
                return false;
            stored.View = stored.View with { Seen = true };
            Persist(cache);
            return true;
        }
    }

    public ResultJobView? Remove(string id)
    {
        lock (_lock)
        {
            var cache = Cache();
            if (cache.FirstOrDefault(s => s.View.Id == id) is not { } stored)
                return null;
            cache.Remove(stored);
            Persist(cache);
            return stored.View;
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
