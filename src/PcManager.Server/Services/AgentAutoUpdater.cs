using Microsoft.EntityFrameworkCore;
using PcManager.Server.Data;
using PcManager.Shared;

namespace PcManager.Server.Services;

/// <summary>
/// 서버 런처가 업데이트하며 띄운 서버(환경변수 PCM_UPDATE_AGENTS=1)는 서버보다 구버전인 에이전트를 자동으로 올린다.
/// 실행 중·대기 중인 명령이 있는 에이전트는 끝날 때까지 미루고, 나중에 켜진 PC도 접속하면 올린다.
/// 에이전트마다 한 번만 보낸다 (업데이트에 실패해 구버전으로 다시 접속해도 반복하지 않는다)
/// </summary>
public class AgentAutoUpdater(
    UpdateService updates,
    AgentRegistry registry,
    IDbContextFactory<AppDbContext> dbFactory,
    ILogger<AgentAutoUpdater> logger) : BackgroundService
{
    public const string EnableVariable = "PCM_UPDATE_AGENTS";

    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(30);
    private readonly HashSet<string> _dispatched = [];

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (Environment.GetEnvironmentVariable(EnableVariable) != "1")
            return;
        logger.LogInformation("구버전 에이전트 자동 업데이트 켜짐 (작업 중이 아닌 에이전트부터)");
        try
        {
            // 서버가 다시 뜬 직후 에이전트들이 재접속할 시간을 준다
            await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken);
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await DispatchAsync(stoppingToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning("에이전트 자동 업데이트 확인 실패: {Message}", ex.Message);
                }
                await Task.Delay(Interval, stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    private async Task DispatchAsync(CancellationToken ct)
    {
        List<string> targets;
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            var agents = await db.Agents.AsNoTracking().Select(a => new { a.Id, a.AgentVersion }).ToListAsync(ct);
            var candidates = agents
                .Where(a => !_dispatched.Contains(a.Id) && registry.IsOnline(a.Id) && UpdateService.IsOlder(a.AgentVersion))
                .Select(a => a.Id)
                .ToList();
            if (candidates.Count == 0)
                return;
            var busy = await db.Runs
                .Where(r => candidates.Contains(r.AgentId) && (r.State == RunState.Pending || r.State == RunState.Running))
                .Select(r => r.AgentId)
                .Distinct()
                .ToListAsync(ct);
            targets = candidates.Except(busy).ToList();
        }
        if (targets.Count == 0)
            return;
        _dispatched.UnionWith(targets);
        await updates.UpdateAgentsAsync(targets);
    }
}
