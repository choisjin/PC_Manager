using System.Collections.Concurrent;
using System.Net.WebSockets;
using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Server.Services;
using PcManager.Shared;

namespace PcManager.Server.Api;

/// <summary>
/// 원격조작 WebSocket 중계.
///   브라우저 ─ /api/agents/{agentId}/remote ─ 서버 ─ /api/agent/remote/{sessionId} ─ 에이전트 원격조작 프로세스
/// 브라우저가 접속하면 서버가 세션 ID를 만들어 에이전트에 StartRemote를 보내고, 원격조작 프로세스가 접속해 오면 둘을 잇는다.
/// 메시지는 해석하지 않고 그대로 전달한다 (영상: 에이전트→브라우저 바이너리, 입력: 브라우저→에이전트 JSON).
/// </summary>
public static class RemoteEndpoints
{
    private static readonly TimeSpan StartTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan AttachTimeout = TimeSpan.FromSeconds(20);

    /// <summary>에이전트 쪽 소켓을 기다리는 세션. ThumbnailService도 같은 경로(/api/agent/remote/{id})로 받는다</summary>
    internal static readonly ConcurrentDictionary<string, PendingSession> Pending = new();

    public static void MapRemoteApi(this WebApplication app)
    {
        app.Map("/api/agents/{agentId}/remote", HandleViewerAsync);
        app.Map("/api/agent/remote/{sessionId}", HandleAgentAsync);
        app.MapPost("/api/agents/{agentId}/remote/cad",
            (string agentId, AgentRegistry registry, IHubContext<AgentHub> agentHub, CancellationToken ct) =>
                InvokeAgentAsync(agentId, AgentClientMethods.SendSecureAttention, registry, agentHub, ct));
        // Linux PC: Xorg로 바꾸고 재부팅 (Wayland에서는 원격조작 불가)
        app.MapPost("/api/agents/{agentId}/linux/x11",
            (string agentId, AgentRegistry registry, IHubContext<AgentHub> agentHub, CancellationToken ct) =>
                InvokeAgentAsync(agentId, AgentClientMethods.SwitchToX11, registry, agentHub, ct));
    }

    private static async Task HandleViewerAsync(
        string agentId, HttpContext context, AgentRegistry registry, IHubContext<AgentHub> agentHub, ILoggerFactory loggers,
        PcStatusStore statuses, RemoteUsageRegistry usage, OrgStore org, IHubContext<DashboardHub, IDashboardClient> dashboard)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        var logger = loggers.CreateLogger(nameof(RemoteEndpoints));
        using var viewer = await context.WebSockets.AcceptWebSocketAsync();
        var ct = context.RequestAborted;

        if (!registry.TryGetConnection(agentId, out var connectionId))
        {
            await CloseAsync(viewer, WebSocketCloseStatus.EndpointUnavailable, "PC가 오프라인입니다.");
            return;
        }

        // 브라우저 WebSocket은 헤더를 못 보내므로 사용자 id는 쿼리로 받는다
        var userId = context.Request.Query["user"].ToString();
        if (string.IsNullOrWhiteSpace(userId))
            userId = "anonymous";

        // 수동 상태가 '사용 금지'면 차단, 다른 사용자가 원격조작 중이면 차단
        if (statuses.Get(agentId) is { Status: PcStatusValues.Forbidden } forbidden)
        {
            await CloseAsync(viewer, WebSocketCloseStatus.PolicyViolation, $"사용 금지 상태입니다.{(forbidden.Note is null ? "" : $" ({forbidden.Note})")}");
            return;
        }
        if (usage.TryAcquire(agentId, userId) is { } otherUser)
        {
            var name = org.Load().Users.FirstOrDefault(u => u.Id == otherUser)?.Name ?? "다른 사용자";
            await CloseAsync(viewer, WebSocketCloseStatus.PolicyViolation, $"{name}님이 원격조작 중입니다.");
            return;
        }
        await dashboard.Clients.All.RemoteUsageChanged(usage.Snapshot());

        var sessions = new List<string>();
        try
        {
            // 첫 연결
            var (agent, error) = await StartSessionAsync(agentId, connectionId, sessions, agentHub, ct);
            if (agent is null)
            {
                await CloseAsync(viewer, WebSocketCloseStatus.InternalServerError, error!);
                return;
            }
            logger.LogInformation("원격조작 연결: {AgentId} (세션 {SessionId})", agentId, sessions[^1]);

            // 브라우저 → 에이전트: 브라우저 소켓은 끝까지 하나로 읽고, 지금 붙어 있는 원격조작 프로세스로 보낸다
            var relay = new AgentRelay(agent);
            using var relayCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var fromViewer = relay.PumpFromViewerAsync(viewer, relayCts.Token);

            // 에이전트 → 브라우저: 원격조작 프로세스가 끝나도(로그인으로 세션이 바뀌는 등) 브라우저가 열려 있으면
            // 새 세션에 다시 띄워 같은 연결에 잇는다 (RDP처럼 로그인 후에도 이어짐)
            var fromAgents = Task.Run(async () =>
            {
                while (true)
                {
                    await PumpAsync(relay.Current, viewer, relayCts.Token);
                    pendingDone(sessions[^1]);
                    if (relayCts.IsCancellationRequested || viewer.State != WebSocketState.Open)
                        return;

                    await relay.CloseCurrentAsync();
                    await SendTextAsync(viewer, """{"type":"status","note":"reattaching"}""", relayCts.Token);
                    logger.LogInformation("원격조작 프로세스 종료 → 다시 연결 시도: {AgentId}", agentId);

                    WebSocket? next = null;
                    for (var tryCount = 0; tryCount < ReattachTries && next is null && !relayCts.IsCancellationRequested; tryCount++)
                    {
                        // 로그인 직후에는 새 세션이 준비될 때까지 잠깐 걸린다
                        await Task.Delay(TimeSpan.FromSeconds(tryCount == 0 ? 1.5 : 3), relayCts.Token);
                        if (!registry.TryGetConnection(agentId, out var conn))
                            continue;
                        (next, error) = await StartSessionAsync(agentId, conn, sessions, agentHub, relayCts.Token);
                    }
                    if (next is null)
                        return;
                    relay.Attach(next);
                    logger.LogInformation("원격조작 다시 연결됨: {AgentId} (세션 {SessionId})", agentId, sessions[^1]);
                }
            }, relayCts.Token);

            try
            {
                await Task.WhenAny(fromViewer, fromAgents);
                await CloseAsync(viewer, WebSocketCloseStatus.NormalClosure, "원격조작이 종료되었습니다.");
                await relay.CloseCurrentAsync();
                relayCts.CancelAfter(TimeSpan.FromSeconds(3));
                try { await Task.WhenAll(fromViewer, fromAgents); } catch (OperationCanceledException) { }
            }
            finally
            {
                logger.LogInformation("원격조작 종료: {AgentId}", agentId);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // 브라우저가 닫음
        }
        finally
        {
            foreach (var id in sessions)
                pendingDone(id);
            usage.Release(agentId, userId);
            await dashboard.Clients.All.RemoteUsageChanged(usage.Snapshot());
        }

        static void pendingDone(string id)
        {
            if (Pending.TryRemove(id, out var p))
                p.Done.TrySetResult();
        }
    }

    private const int ReattachTries = 8;

    /// <summary>에이전트에 원격조작 프로세스를 띄우고 접속해 올 때까지 기다린다.</summary>
    private static async Task<(WebSocket? Agent, string? Error)> StartSessionAsync(
        string agentId, string connectionId, List<string> sessions, IHubContext<AgentHub> agentHub, CancellationToken ct)
    {
        var sessionId = Guid.NewGuid().ToString("N");
        var pending = new PendingSession();
        Pending[sessionId] = pending;
        sessions.Add(sessionId);
        try
        {
            using var startCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            startCts.CancelAfter(StartTimeout);
            var error = await agentHub.Clients.Client(connectionId)
                .InvokeAsync<string?>(AgentClientMethods.StartRemote, sessionId, startCts.Token);
            if (error is not null)
                return (null, error);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            return (null, ex is OperationCanceledException
                ? "에이전트가 응답하지 않습니다. (원격조작을 지원하지 않는 이전 버전일 수 있습니다)"
                : $"에이전트 호출 실패: {ex.Message}");
        }

        try
        {
            return (await pending.Agent.Task.WaitAsync(AttachTimeout, ct), null);
        }
        catch (TimeoutException)
        {
            return (null, "원격조작 프로세스가 접속하지 않았습니다.");
        }
    }

    private static async Task SendTextAsync(WebSocket socket, string text, CancellationToken ct)
    {
        try
        {
            await socket.SendAsync(System.Text.Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, ct);
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException)
        {
            // 연결 종료
        }
    }

    /// <summary>브라우저 입력을 지금 붙어 있는 원격조작 프로세스로 보낸다. 다시 연결하면 대상이 바뀐다.</summary>
    private sealed class AgentRelay(WebSocket initial)
    {
        private readonly SemaphoreSlim _sendLock = new(1, 1);
        private volatile WebSocket _current = initial;

        public WebSocket Current => _current;

        public void Attach(WebSocket socket) => _current = socket;

        public async Task CloseCurrentAsync()
        {
            await _sendLock.WaitAsync();
            try
            {
                await CloseAsync(_current, WebSocketCloseStatus.NormalClosure, "종료");
            }
            finally
            {
                _sendLock.Release();
            }
        }

        public async Task PumpFromViewerAsync(WebSocket viewer, CancellationToken ct)
        {
            var buffer = new byte[64 * 1024];
            try
            {
                while (viewer.State is WebSocketState.Open or WebSocketState.CloseSent)
                {
                    var result = await viewer.ReceiveAsync(buffer, ct);
                    if (result.MessageType == WebSocketMessageType.Close)
                        return;
                    await _sendLock.WaitAsync(ct);
                    try
                    {
                        // 다시 연결하는 동안의 입력은 버린다
                        var target = _current;
                        if (target.State is WebSocketState.Open or WebSocketState.CloseReceived)
                            await target.SendAsync(buffer.AsMemory(0, result.Count), result.MessageType, result.EndOfMessage, ct);
                    }
                    catch (WebSocketException)
                    {
                        // 원격조작 프로세스 쪽이 끊김 → 다시 연결을 기다린다
                    }
                    finally
                    {
                        _sendLock.Release();
                    }
                }
            }
            catch (Exception ex) when (ex is WebSocketException or OperationCanceledException)
            {
                // 연결 종료
            }
        }
    }

    /// <summary>에이전트 원격조작 프로세스 접속. 토큰 검증은 /api/agent 미들웨어가 처리한다</summary>
    private static async Task HandleAgentAsync(string sessionId, HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest || !Pending.TryGetValue(sessionId, out var pending))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        using var agent = await context.WebSockets.AcceptWebSocketAsync();
        if (!pending.Agent.TrySetResult(agent))
        {
            await CloseAsync(agent, WebSocketCloseStatus.PolicyViolation, "이미 연결된 세션입니다.");
            return;
        }

        // 중계가 끝날 때까지 요청을 유지해야 소켓이 살아 있다
        await pending.Done.Task.WaitAsync(context.RequestAborted).ContinueWith(_ => { }, TaskScheduler.Default);
    }

    /// <summary>에이전트의 () → string? 오류 메서드를 부른다 (null이면 204, 오류면 400)</summary>
    private static async Task<IResult> InvokeAgentAsync(string agentId, string method, AgentRegistry registry, IHubContext<AgentHub> agentHub, CancellationToken ct)
    {
        if (!registry.TryGetConnection(agentId, out var connectionId))
            return Results.Conflict("PC가 오프라인입니다.");
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(StartTimeout);
            var error = await agentHub.Clients.Client(connectionId).InvokeAsync<string?>(method, cts.Token);
            return error is null ? Results.NoContent() : Results.BadRequest(error);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            return Results.Problem($"에이전트 호출 실패: {ex.Message}", statusCode: StatusCodes.Status502BadGateway);
        }
    }

    internal static async Task PumpAsync(WebSocket from, WebSocket to, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        try
        {
            while (from.State is WebSocketState.Open or WebSocketState.CloseSent)
            {
                var result = await from.ReceiveAsync(buffer, ct);
                if (result.MessageType == WebSocketMessageType.Close)
                    return;
                if (to.State is WebSocketState.Open or WebSocketState.CloseReceived)
                    await to.SendAsync(buffer.AsMemory(0, result.Count), result.MessageType, result.EndOfMessage, ct);
            }
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException)
        {
            // 연결 종료
        }
    }

    internal static async Task CloseAsync(WebSocket socket, WebSocketCloseStatus status, string reason)
    {
        if (socket.State is not (WebSocketState.Open or WebSocketState.CloseReceived))
            return;
        try
        {
            // 닫기 프레임만 보낸다 (다른 쪽에서 수신 중일 수 있어 CloseAsync는 쓰지 않는다). 사유는 123바이트까지
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            await socket.CloseOutputAsync(status, TrimReason(reason), cts.Token);
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException)
        {
            // 이미 끊김
        }
    }

    private static string TrimReason(string reason)
    {
        while (System.Text.Encoding.UTF8.GetByteCount(reason) > 123)
            reason = reason[..^1];
        return reason;
    }

    internal sealed class PendingSession
    {
        public TaskCompletionSource<WebSocket> Agent { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Done { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}
