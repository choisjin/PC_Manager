namespace PcManager.Server.Services;

/// <summary>지금 어떤 사용자가 어떤 PC(에이전트/공유)를 보고 있는지 in-memory로 추적한다 (실시간 프레즌스).</summary>
public class PresenceRegistry
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, Entry> _byConnection = new();
    // 대시보드를 열어 둔 사용자 (탭과 상관없이): connectionId → userId
    private readonly Dictionary<string, string> _users = new();

    private sealed record Entry(string UserId, HashSet<string> Agents);

    public void Set(string connectionId, string userId, IEnumerable<string> agentIds)
    {
        lock (_lock)
        {
            _byConnection[connectionId] = new Entry(userId, agentIds.ToHashSet());
            _users[connectionId] = userId;
        }
    }

    /// <summary>이 접속의 사용자 (대시보드를 열면 알린다)</summary>
    public void SetUser(string connectionId, string userId)
    {
        lock (_lock)
        {
            _users[connectionId] = userId;
        }
    }

    /// <summary>지금 대시보드를 열어 둔 사용자 id (중복 없이)</summary>
    public IReadOnlyList<string> OnlineUsers()
    {
        lock (_lock)
        {
            return _users.Values.Distinct().ToList();
        }
    }

    public void Remove(string connectionId)
    {
        lock (_lock)
        {
            _byConnection.Remove(connectionId);
            _users.Remove(connectionId);
        }
    }

    /// <summary>agentId → 지금 보고 있는 userId 목록</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<string>> Snapshot()
    {
        lock (_lock)
        {
            var map = new Dictionary<string, HashSet<string>>();
            foreach (var entry in _byConnection.Values)
            {
                foreach (var agentId in entry.Agents)
                {
                    if (!map.TryGetValue(agentId, out var users))
                        map[agentId] = users = [];
                    users.Add(entry.UserId);
                }
            }
            return map.ToDictionary(kv => kv.Key, kv => (IReadOnlyList<string>)kv.Value.ToList());
        }
    }
}
