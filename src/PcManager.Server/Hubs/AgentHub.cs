using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using PcManager.Server.Contracts;
using PcManager.Server.Data;
using PcManager.Server.Services;
using PcManager.Shared;

namespace PcManager.Server.Hubs;

/// <summary>테스트 PC 에이전트가 접속하는 Hub. 토큰 검증은 Program.cs 미들웨어에서 처리한다.</summary>
public class AgentHub(
    AgentRegistry registry,
    RunService runs,
    TransferService transfers,
    IDbContextFactory<AppDbContext> dbFactory,
    IHubContext<DashboardHub, IDashboardClient> dashboard,
    ILogger<AgentHub> logger) : Hub<IAgentClient>
{
    private const string AgentIdKey = "AgentId";

    /// <param name="unreportedIds">에이전트가 진행 중이거나 결과를 아직 보내지 못한 명령/전송 ID</param>
    public async Task Register(AgentInfo info, IReadOnlyList<string> unreportedIds)
    {
        if (!Guid.TryParseExact(info.AgentId, "N", out _))
            throw new HubException("잘못된 AgentId 형식입니다.");

        var now = DateTime.UtcNow;
        AgentEntity agent;
        await using (var db = await dbFactory.CreateDbContextAsync())
        {
            agent = await db.Agents.FindAsync(info.AgentId)
                ?? db.Agents.Add(new AgentEntity { Id = info.AgentId, FirstSeenAt = now }).Entity;
            agent.MachineName = info.MachineName;
            agent.OsVersion = info.OsVersion;
            agent.AgentVersion = info.AgentVersion;
            agent.UserName = info.UserName;
            agent.IpAddresses = [.. info.IpAddresses];
            agent.MacAddresses = [.. info.MacAddresses];
            agent.Tags = [.. info.Tags];
            agent.LastSeenAt = now;
            await db.SaveChangesAsync();
        }

        await runs.FailOrphanedRunsAsync(info.AgentId, unreportedIds);
        await transfers.FailOrphanedAsync(info.AgentId, unreportedIds);

        Context.Items[AgentIdKey] = info.AgentId;
        registry.Set(info.AgentId, Context.ConnectionId);
        await dashboard.Clients.All.AgentUpdated(agent.ToView(online: true));
        logger.LogInformation("에이전트 등록: {MachineName} ({AgentId})", info.MachineName, info.AgentId);
    }

    public Task ReportStarted(CommandStarted started) => runs.MarkStartedAsync(GetAgentId(), started);

    public Task ReportOutput(IReadOnlyList<CommandOutput> lines) => runs.AppendOutputAsync(GetAgentId(), lines);

    public Task ReportCompleted(CommandCompleted completed) => runs.MarkCompletedAsync(GetAgentId(), completed);

    public Task ReportTransferCompleted(TransferCompleted completed) => transfers.MarkCompletedAsync(GetAgentId(), completed);

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        // 재접속으로 이미 새 연결이 등록된 경우에는 오프라인 처리하지 않는다
        if (Context.Items.TryGetValue(AgentIdKey, out var value)
            && value is string agentId
            && registry.Remove(agentId, Context.ConnectionId))
        {
            await using var db = await dbFactory.CreateDbContextAsync();
            if (await db.Agents.FindAsync(agentId) is { } agent)
            {
                agent.LastSeenAt = DateTime.UtcNow;
                await db.SaveChangesAsync();
                await dashboard.Clients.All.AgentUpdated(agent.ToView(online: false));
            }
            logger.LogInformation("에이전트 연결 끊김: {AgentId}", agentId);
        }

        await base.OnDisconnectedAsync(exception);
    }

    private string GetAgentId()
    {
        if (Context.Items.TryGetValue(AgentIdKey, out var value) && value is string agentId)
            return agentId;

        // 등록 전 보고는 받지 않고 연결을 끊어 재등록을 유도한다
        Context.Abort();
        throw new HubException("Register 호출 전에는 보고할 수 없습니다.");
    }
}
