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

    private static readonly ConcurrentDictionary<string, PendingSession> Pending = new();

    public static void MapRemoteApi(this WebApplication app)
    {
        app.Map("/api/agents/{agentId}/remote", HandleViewerAsync);
        app.Map("/api/agent/remote/{sessionId}", HandleAgentAsync);
        app.MapPost("/api/agents/{agentId}/remote/cad", SendSecureAttentionAsync);
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

        var sessionId = Guid.NewGuid().ToString("N");
        var pending = new PendingSession();
        Pending[sessionId] = pending;
        try
        {
            string? error;
            try
            {
                using var startCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                startCts.CancelAfter(StartTimeout);
                error = await agentHub.Clients.Client(connectionId)
                    .InvokeAsync<string?>(AgentClientMethods.StartRemote, sessionId, startCts.Token);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                error = ex is OperationCanceledException
                    ? "에이전트가 응답하지 않습니다. (원격조작을 지원하지 않는 이전 버전일 수 있습니다)"
                    : $"에이전트 호출 실패: {ex.Message}";
            }
            if (error is not null)
            {
                await CloseAsync(viewer, WebSocketCloseStatus.InternalServerError, error);
                return;
            }

            WebSocket agent;
            try
            {
                agent = await pending.Agent.Task.WaitAsync(AttachTimeout, ct);
            }
            catch (TimeoutException)
            {
                await CloseAsync(viewer, WebSocketCloseStatus.InternalServerError, "원격조작 프로세스가 접속하지 않았습니다.");
                return;
            }

            logger.LogInformation("원격조작 연결: {AgentId} (세션 {SessionId})", agentId, sessionId);
            try
            {
                // 한쪽이 끝나면 다른 쪽에도 닫기를 보내고, 잠시 뒤에도 안 끝나면 끊는다
                using var relayCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                var toViewer = PumpAsync(agent, viewer, relayCts.Token);
                var toAgent = PumpAsync(viewer, agent, relayCts.Token);
                await Task.WhenAny(toViewer, toAgent);
                await CloseAsync(viewer, WebSocketCloseStatus.NormalClosure, "원격조작이 종료되었습니다.");
                await CloseAsync(agent, WebSocketCloseStatus.NormalClosure, "종료");
                relayCts.CancelAfter(TimeSpan.FromSeconds(3));
                await Task.WhenAll(toViewer, toAgent);
            }
            finally
            {
                pending.Done.TrySetResult();
                logger.LogInformation("원격조작 종료: {AgentId} (세션 {SessionId})", agentId, sessionId);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // 브라우저가 닫음
        }
        finally
        {
            Pending.TryRemove(sessionId, out _);
            pending.Done.TrySetResult();
            usage.Release(agentId, userId);
            await dashboard.Clients.All.RemoteUsageChanged(usage.Snapshot());
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

    private static async Task<IResult> SendSecureAttentionAsync(string agentId, AgentRegistry registry, IHubContext<AgentHub> agentHub, CancellationToken ct)
    {
        if (!registry.TryGetConnection(agentId, out var connectionId))
            return Results.Conflict("PC가 오프라인입니다.");
        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(StartTimeout);
            var error = await agentHub.Clients.Client(connectionId).InvokeAsync<string?>(AgentClientMethods.SendSecureAttention, cts.Token);
            return error is null ? Results.NoContent() : Results.BadRequest(error);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            return Results.Problem($"에이전트 호출 실패: {ex.Message}", statusCode: StatusCodes.Status502BadGateway);
        }
    }

    private static async Task PumpAsync(WebSocket from, WebSocket to, CancellationToken ct)
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

    private static async Task CloseAsync(WebSocket socket, WebSocketCloseStatus status, string reason)
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

    private sealed class PendingSession
    {
        public TaskCompletionSource<WebSocket> Agent { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Done { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}
