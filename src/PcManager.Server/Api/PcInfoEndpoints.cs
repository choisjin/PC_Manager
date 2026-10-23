using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Hubs;
using PcManager.Server.Services;
using PcManager.Shared;

namespace PcManager.Server.Api;

/// <summary>
/// PC 정보 패널 (PC 목록 아래): 시스템 정보·디스크·프로세스·성능·장치를 테스트 PC 에이전트에 묻는다.
/// 대시보드가 패널을 열어 그 탭을 보고 있을 때만 부른다 (성능 1초 · 프로세스 2초 · 나머지는 열 때).
/// </summary>
public static class PcInfoEndpoints
{
    public static void MapPcInfoApi(this WebApplication app)
    {
        app.MapGet("/api/agents/{agentId}/info/system", (string agentId, AgentRegistry registry, IHubContext<AgentHub> agentHub,
            CancellationToken ct) =>
            Ask<PcSystemInfo>(agentId, registry, agentHub, TimeSpan.FromSeconds(20), AgentClientMethods.GetSystemInfo, [], ct));

        app.MapGet("/api/agents/{agentId}/info/processes", (string agentId, AgentRegistry registry, IHubContext<AgentHub> agentHub,
            CancellationToken ct) =>
            Ask<ProcessList>(agentId, registry, agentHub, TimeSpan.FromSeconds(10), AgentClientMethods.GetProcesses, [], ct));

        // after: 이미 받은 마지막 측정 번호 (그 뒤 것만 받는다)
        app.MapGet("/api/agents/{agentId}/info/performance", (string agentId, long? after, AgentRegistry registry,
            IHubContext<AgentHub> agentHub, CancellationToken ct) =>
            Ask<PerfHistory>(agentId, registry, agentHub, TimeSpan.FromSeconds(10), AgentClientMethods.GetPerformance, [after ?? 0], ct));

        app.MapGet("/api/agents/{agentId}/info/devices", (string agentId, AgentRegistry registry, IHubContext<AgentHub> agentHub,
            CancellationToken ct) =>
            Ask<DeviceList>(agentId, registry, agentHub, TimeSpan.FromSeconds(30), AgentClientMethods.GetDevices, [], ct));
    }

    /// <summary>에이전트에 묻는다. 답이 늦으면 504 (멈춘 PC 때문에 요청이 쌓이지 않게)</summary>
    private static async Task<IResult> Ask<T>(string agentId, AgentRegistry registry, IHubContext<AgentHub> agentHub, TimeSpan limit,
        string method, object?[] args, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(limit);
        try
        {
            return await ResultSetEndpoints.CallAgent(agentId, registry, agentHub, async proxy =>
                Results.Ok(await proxy.InvokeCoreAsync<T>(method, args, timeout.Token)));
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return Results.Problem("PC가 응답하지 않습니다", statusCode: StatusCodes.Status504GatewayTimeout);
        }
    }
}
