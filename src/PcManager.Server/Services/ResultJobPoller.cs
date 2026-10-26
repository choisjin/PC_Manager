using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Shared;

namespace PcManager.Server.Services;

/// <summary>
/// 돌고 있는 결과 확인 작업(영상 분석·이미지 찾기)의 진행을 에이전트에 물어 목록을 고치고 대시보드에 알린다.
/// 결과 확인 탭을 닫아도 진행·완료가 보이게 (에이전트도 묻는 웹이 없으면 멈추던 옛 에이전트가 이 묻기로 계속 돈다).
/// PC가 오프라인이면 다시 연결될 때까지 그대로 둔다
/// </summary>
public class ResultJobPoller(
    ResultJobStore store, AgentRegistry registry, IHubContext<AgentHub> agentHub,
    IHubContext<DashboardHub, IDashboardClient> dashboard, ILogger<ResultJobPoller> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(10);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                var changed = false;
                foreach (var job in store.Running())
                {
                    if (!registry.TryGetConnection(job.AgentId, out var connectionId))
                        continue;
                    try
                    {
                        changed |= await PollAsync(job, agentHub.Clients.Client(connectionId), stoppingToken);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException || !stoppingToken.IsCancellationRequested)
                    {
                        logger.LogDebug("결과 확인 작업 {Id} 진행 묻기 실패: {Message}", job.Id, ex.Message);
                    }
                }
                if (changed)
                    await dashboard.Clients.All.ResultJobsChanged(store.List());
                await Task.Delay(Interval, stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    private async Task<bool> PollAsync(ResultJobView job, ISingleClientProxy proxy, CancellationToken stoppingToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        timeout.CancelAfter(CallTimeout);
        // 결과 조각 없이 진행만 (영상 차례를 끝 너머로)
        if (job.Kind == ResultJobKinds.Analysis)
        {
            var p = await proxy.InvokeAsync<VideoAnalysisProgress?>(AgentClientMethods.GetVideoAnalysisChunks, job.Id, int.MaxValue, 0, timeout.Token);
            return p is null
                ? store.Update(job.Id, "lost", job.Progress, null, "에이전트에서 작업이 사라졌습니다 (에이전트가 다시 시작됨)")
                : store.Update(job.Id, p.State, p.Progress, p.Current, p.Error);
        }
        var s = await proxy.InvokeAsync<ImageSearchStatus?>(AgentClientMethods.GetImageSearch, job.Id, int.MaxValue, timeout.Token);
        return s is null
            ? store.Update(job.Id, "lost", job.Progress, null, "에이전트에서 작업이 사라졌습니다 (에이전트가 다시 시작됨)")
            : store.Update(job.Id, s.State, s.Progress, s.Current, s.Error);
    }
}
