using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Server.Services;
using PcManager.Shared;

namespace PcManager.Server.Api;

/// <summary>설정 '에이전트 서버 주소 일괄 변경' (관리자): 고른 PC의 에이전트가 새 서버로 옮겨 간다</summary>
public static class AgentServerEndpoints
{
    public static void MapAgentServerApi(this WebApplication app)
    {
        app.MapPost("/api/agents/server-url", async (HttpContext context, ServerUrlRequest req, OrgStore store, AuthStore auth,
            AgentRegistry registry, IHubContext<AgentHub> agentHub, CancellationToken ct) =>
        {
            var (_, user, project) = OrgEndpoints.Current(context, store, auth);
            if (user?.Role != OrgUser.AdminRole || project is null)
                return OrgEndpoints.Error(403, "관리자 권한이 필요합니다.");
            var url = req.ServerUrl?.Trim();
            if (string.IsNullOrEmpty(url))
                return OrgEndpoints.Error(400, "새 서버 주소를 입력하세요.");
            if (req.AgentIds is not { Count: > 0 })
                return OrgEndpoints.Error(400, "PC를 고르세요.");

            // 각 에이전트가 새 서버 응답을 확인하느라 몇 초 걸릴 수 있어 동시에 보낸다
            var results = await Task.WhenAll(req.AgentIds.Distinct().Select(async agentId =>
            {
                if (!registry.TryGetConnection(agentId, out var conn))
                    return new ServerUrlResult(agentId, false, "오프라인");
                try
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    timeout.CancelAfter(TimeSpan.FromSeconds(20));
                    var error = await agentHub.Clients.Client(conn)
                        .InvokeAsync<string?>(AgentClientMethods.SetServerUrl, url, timeout.Token);
                    return new ServerUrlResult(agentId, error is null, error);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    return new ServerUrlResult(agentId, false, "에이전트 응답 시간이 초과되었습니다.");
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    return new ServerUrlResult(agentId, false, TextEndpoints.OldAgentMessage(ex));
                }
            }));
            return Results.Ok(results);
        });
    }

    public record ServerUrlRequest(string? ServerUrl, IReadOnlyList<string>? AgentIds);

    /// <param name="Error">실패 이유 (오프라인, 새 서버에 연결 불가, 옛 버전 에이전트 등)</param>
    public record ServerUrlResult(string AgentId, bool Ok, string? Error);
}
