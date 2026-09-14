using System.Collections.Concurrent;

namespace PcManager.Server.Services;

/// <summary>접속 중인 에이전트 ID ↔ SignalR 연결 ID</summary>
public class AgentRegistry
{
    private readonly ConcurrentDictionary<string, string> _connections = new();

    public void Set(string agentId, string connectionId) => _connections[agentId] = connectionId;

    /// <summary>해당 연결이 현재 연결일 때만 제거한다 (재접속으로 교체된 경우 무시)</summary>
    public bool Remove(string agentId, string connectionId) =>
        _connections.TryRemove(new KeyValuePair<string, string>(agentId, connectionId));

    public bool TryGetConnection(string agentId, out string connectionId) =>
        _connections.TryGetValue(agentId, out connectionId!);

    public bool IsOnline(string agentId) => _connections.ContainsKey(agentId);
}
