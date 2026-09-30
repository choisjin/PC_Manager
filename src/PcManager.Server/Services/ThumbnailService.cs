using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Api;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Shared;

namespace PcManager.Server.Services;

/// <summary>
/// 대시보드 Remote 화면용 PC 썸네일. 보고 있는 대시보드가 하나라도 있는 PC마다 에이전트에 썸네일 프로세스를 띄워
/// 작은 JPEG를 주기적으로 받고, SignalR로 대시보드에 뿌린다. 아무도 안 보면 세션을 끝낸다.
/// </summary>
public class ThumbnailService(
    AgentRegistry registry,
    IHubContext<AgentHub> agentHub,
    IHubContext<DashboardHub, IDashboardClient> dashboard,
    ILogger<ThumbnailService> logger)
{
    public const string Group = "thumbnails";

    // 중첩 클래스에서 쓰기 위해 필드로 둔다
    private readonly AgentRegistry _registry = registry;
    private readonly IHubContext<AgentHub> _agentHub = agentHub;
    private readonly ILogger<ThumbnailService> _logger = logger;
    private static readonly TimeSpan StartTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan AttachTimeout = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan IdleStop = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan RetryDelay = TimeSpan.FromSeconds(5);

    private readonly Lock _lock = new();
    // 대시보드 연결 → 보고 싶은 agentId
    private readonly Dictionary<string, HashSet<string>> _wants = new();
    // agentId → 실행 중인 썸네일 세션
    private readonly Dictionary<string, Session> _sessions = new();
    // 마지막 썸네일 (새로 보는 대시보드에 바로 보여 주려고)
    private readonly ConcurrentDictionary<string, ThumbnailView> _latest = new();

    public IReadOnlyCollection<ThumbnailView> Latest => _latest.Values.ToList();

    /// <summary>이 대시보드가 보고 싶은 PC 목록 (빈 목록 = 안 봄)</summary>
    public void SetWants(string connectionId, IEnumerable<string> agentIds)
    {
        lock (_lock)
        {
            var set = agentIds.ToHashSet();
            if (set.Count == 0)
                _wants.Remove(connectionId);
            else
                _wants[connectionId] = set;
            Reconcile();
        }
    }

    public void RemoveConnection(string connectionId)
    {
        lock (_lock)
        {
            if (_wants.Remove(connectionId))
                Reconcile();
        }
    }

    /// <summary>에이전트가 끊기면 마지막 썸네일을 지운다 (카드는 오프라인으로 표시됨)</summary>
    public void AgentOffline(string agentId) => _latest.TryRemove(agentId, out _);

    /// <summary>에이전트가 (재)접속하면, 보고 있는 대시보드가 있을 때 기다리지 않고 바로 썸네일 세션을 시작한다</summary>
    public void AgentOnline(string agentId)
    {
        lock (_lock)
        {
            if (_wants.Values.Any(s => s.Contains(agentId)))
                Reconcile();
        }
    }

    private void Reconcile()
    {
        var wanted = _wants.Values.SelectMany(s => s).ToHashSet();
        foreach (var agentId in wanted)
        {
            if (!_sessions.ContainsKey(agentId))
            {
                var session = new Session(this, agentId);
                _sessions[agentId] = session;
                _ = session.RunAsync();
            }
        }
        foreach (var (agentId, session) in _sessions.ToList())
        {
            if (!wanted.Contains(agentId))
                session.RequestStop();
            else
                session.CancelStop();
        }
    }

    private void SessionEnded(string agentId, Session session)
    {
        lock (_lock)
        {
            if (_sessions.TryGetValue(agentId, out var cur) && ReferenceEquals(cur, session))
                _sessions.Remove(agentId);
            // 아직 보고 싶은 사람이 있으면 잠시 뒤 다시 시도한다
            if (_wants.Values.Any(s => s.Contains(agentId)))
                _ = Task.Delay(RetryDelay).ContinueWith(_ => { lock (_lock) Reconcile(); }, TaskScheduler.Default);
        }
    }

    private async Task PublishAsync(ThumbnailView view)
    {
        _latest[view.AgentId] = view;
        await dashboard.Clients.Group(Group).ThumbnailUpdated(view);
    }

    private sealed class Session(ThumbnailService owner, string agentId)
    {
        private readonly CancellationTokenSource _cts = new();
        private CancellationTokenSource? _stopTimer;

        public void RequestStop()
        {
            if (_stopTimer is not null)
                return;
            var timer = _stopTimer = new CancellationTokenSource();
            _ = Task.Delay(IdleStop, timer.Token).ContinueWith(t =>
            {
                if (!t.IsCanceled)
                    _cts.Cancel();
            }, TaskScheduler.Default);
        }

        public void CancelStop()
        {
            _stopTimer?.Cancel();
            _stopTimer = null;
        }

        public async Task RunAsync()
        {
            var ct = _cts.Token;
            try
            {
                if (!owner._registry.TryGetConnection(agentId, out var connectionId))
                    return;

                var sessionId = Guid.NewGuid().ToString("N");
                var pending = new RemoteEndpoints.PendingSession();
                RemoteEndpoints.Pending[sessionId] = pending;
                try
                {
                    using var startCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    startCts.CancelAfter(StartTimeout);
                    var error = await owner._agentHub.Clients.Client(connectionId)
                        .InvokeAsync<string?>(AgentClientMethods.StartThumbnail, sessionId, startCts.Token);
                    if (error is not null)
                    {
                        owner._logger.LogWarning("썸네일 시작 실패 {AgentId}: {Error}", agentId, error);
                        return;
                    }

                    var agent = await pending.Agent.Task.WaitAsync(AttachTimeout, ct);
                    await ReadAsync(agent, ct);
                    await RemoteEndpoints.CloseAsync(agent, WebSocketCloseStatus.NormalClosure, "종료");
                }
                finally
                {
                    RemoteEndpoints.Pending.TryRemove(sessionId, out _);
                    pending.Done.TrySetResult();
                }
            }
            catch (Exception ex) when (ex is OperationCanceledException or TimeoutException)
            {
                // 아무도 안 봐서 멈췄거나, 에이전트가 붙지 않음
            }
            catch (Exception ex)
            {
                owner._logger.LogWarning("썸네일 세션 오류 {AgentId}: {Message}", agentId, ex.Message);
            }
            finally
            {
                owner.SessionEnded(agentId, this);
            }
        }

        private async Task ReadAsync(WebSocket agent, CancellationToken ct)
        {
            var buffer = new byte[256 * 1024];
            using var message = new MemoryStream();
            while (!ct.IsCancellationRequested && agent.State == WebSocketState.Open)
            {
                var result = await agent.ReceiveAsync(buffer, ct);
                if (result.MessageType == WebSocketMessageType.Close)
                    return;
                message.Write(buffer, 0, result.Count);
                if (!result.EndOfMessage)
                    continue;

                if (result.MessageType == WebSocketMessageType.Binary && message.Length > 5 && message.GetBuffer()[0] == 2)
                {
                    var span = message.GetBuffer().AsSpan(0, (int)message.Length);
                    var idle = BinaryPrimitives.ReadInt32LittleEndian(span[1..5]);
                    var jpeg = Convert.ToBase64String(span[5..]);
                    await owner.PublishAsync(new ThumbnailView(agentId, jpeg, idle, DateTime.UtcNow));
                }
                message.SetLength(0);
            }
        }
    }
}
