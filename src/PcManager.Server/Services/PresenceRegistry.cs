namespace PcManager.Server.Services;

/// <summary>지금 어떤 사용자가 어떤 PC(에이전트/공유)를 보고 있는지 in-memory로 추적한다 (실시간 프레즌스).</summary>
public class PresenceRegistry
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, Entry> _byConnection = new();

    private sealed record Entry(string UserId, HashSet<string> Agents);

    public void Set(string connectionId, string userId, IEnumerable<string> agentIds)
    {
        lock (_lock)
        {
            _byConnection[connectionId] = new Entry(userId, agentIds.ToHashSet());
        }
    }

    public void Remove(string connectionId)
    {
        lock (_lock)
        {
            _byConnection.Remove(connectionId);
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
