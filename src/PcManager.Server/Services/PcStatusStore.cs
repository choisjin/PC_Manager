using System.Text.Json;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>사용자가 수동으로 지정한 PC 상태(테스트 중/사용 금지 등)를 저장한다. 모든 대시보드가 공유한다.</summary>
public class PcStatusStore(AppPaths paths)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "pc-status.json");
    private Dictionary<string, PcStatusView>? _cache;

    public PcStatusesView Load()
    {
        lock (_lock)
            return new PcStatusesView(new Dictionary<string, PcStatusView>(Cache()));
    }

    public PcStatusView? Get(string agentId)
    {
        lock (_lock)
            return Cache().GetValueOrDefault(agentId);
    }

    /// <summary>available로 되돌리면 항목을 지운다</summary>
    public PcStatusesView Set(string agentId, string status, string? note, string? userId)
    {
        if (!PcStatusValues.All.Contains(status))
            throw new ArgumentException("알 수 없는 상태입니다.", nameof(status));
        lock (_lock)
        {
            var cache = Cache();
            if (status == PcStatusValues.Available && string.IsNullOrWhiteSpace(note))
                cache.Remove(agentId);
            else
                cache[agentId] = new PcStatusView(agentId, status, string.IsNullOrWhiteSpace(note) ? null : note.Trim(), userId, DateTime.UtcNow);
            Persist(cache);
            return new PcStatusesView(new Dictionary<string, PcStatusView>(cache));
        }
    }

    private Dictionary<string, PcStatusView> Cache()
    {
        if (_cache is not null)
            return _cache;
        try
        {
            _cache = File.Exists(_path)
                ? JsonSerializer.Deserialize<Dictionary<string, PcStatusView>>(File.ReadAllText(_path), Json) ?? []
                : [];
        }
        catch (JsonException)
        {
            _cache = [];
        }
        return _cache;
    }

    private void Persist(Dictionary<string, PcStatusView> cache)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var tempPath = _path + ".tmp";
        File.WriteAllText(tempPath, JsonSerializer.Serialize(cache, Json));
        File.Move(tempPath, _path, overwrite: true);
    }
}

/// <summary>지금 원격조작 중인 PC와 사용자 (in-memory). 다른 사용자의 접속을 막는 데 쓴다.</summary>
public class RemoteUsageRegistry
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, (string UserId, DateTime Since, int Sessions)> _inUse = new();

    /// <returns>다른 사용자가 쓰는 중이면 그 userId, 아니면 null (같은 사용자는 중복 접속 허용)</returns>
    public string? TryAcquire(string agentId, string userId)
    {
        lock (_lock)
        {
            if (_inUse.TryGetValue(agentId, out var cur) && cur.UserId != userId)
                return cur.UserId;
            _inUse[agentId] = cur.UserId == userId ? (cur.UserId, cur.Since, cur.Sessions + 1) : (userId, DateTime.UtcNow, 1);
            return null;
        }
    }

    public void Release(string agentId, string userId)
    {
        lock (_lock)
        {
            if (!_inUse.TryGetValue(agentId, out var cur) || cur.UserId != userId)
                return;
            if (cur.Sessions <= 1)
                _inUse.Remove(agentId);
            else
                _inUse[agentId] = (cur.UserId, cur.Since, cur.Sessions - 1);
        }
    }

    public RemoteUsageView Snapshot()
    {
        lock (_lock)
            return new RemoteUsageView(_inUse.ToDictionary(kv => kv.Key, kv => new RemoteUserView(kv.Value.UserId, kv.Value.Since)));
    }
}

/// <summary>사용자 간 간단한 채팅. 최근 메시지를 메모리에 두고 파일에도 남긴다.</summary>
public class ChatStore(AppPaths paths)
{
    private const int MaxKeep = 500;
    private const int MaxLength = 2000;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly Lock _lock = new();
    private readonly string _path = Path.Combine(paths.DataDirectory, "chat.jsonl");
    private List<ChatMessageView>? _messages;
    private long _nextId;

    public IReadOnlyList<ChatMessageView> Recent(int take)
    {
        lock (_lock)
        {
            var list = Messages();
            return list.Skip(Math.Max(0, list.Count - take)).ToList();
        }
    }

    public ChatMessageView Add(string userId, string text, IReadOnlyList<string>? mentions = null)
    {
        text = text.Trim();
        if (text.Length == 0)
            throw new ArgumentException("빈 메시지입니다.", nameof(text));
        if (text.Length > MaxLength)
            text = text[..MaxLength];
        lock (_lock)
        {
            var list = Messages();
            var message = new ChatMessageView(++_nextId, userId, text, DateTime.UtcNow, (mentions ?? []).Distinct().Take(50).ToList());
            list.Add(message);
            if (list.Count > MaxKeep)
                list.RemoveRange(0, list.Count - MaxKeep);
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            File.AppendAllText(_path, JsonSerializer.Serialize(message, Json) + Environment.NewLine);
            return message;
        }
    }

    private List<ChatMessageView> Messages()
    {
        if (_messages is not null)
            return _messages;
        _messages = [];
        if (File.Exists(_path))
        {
            foreach (var line in File.ReadLines(_path).TakeLast(MaxKeep))
            {
                try
                {
                    if (JsonSerializer.Deserialize<ChatMessageView>(line, Json) is { } m)
                        _messages.Add(m);
                }
                catch (JsonException)
                {
                    // 깨진 줄은 건너뛴다
                }
            }
        }
        _nextId = _messages.Count > 0 ? _messages[^1].Id : 0;
        return _messages;
    }
}
