using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using PcManager.Server.Contracts;
using PcManager.Server.Data;
using PcManager.Server.Hubs;
using PcManager.Shared;

namespace PcManager.Server.Services;

/// <summary>명령 실행 생성, 에이전트 전달, 상태 전이를 관리한다.</summary>
public class RunService(
    IDbContextFactory<AppDbContext> dbFactory,
    AgentRegistry registry,
    RunLogStore logs,
    CompletionNotifier notifier,
    IHubContext<AgentHub, IAgentClient> agentHub,
    IHubContext<DashboardHub, IDashboardClient> dashboard)
{
    public async Task<List<RunView>> CreateAsync(CreateRunsRequest request)
    {
        var now = DateTime.UtcNow;
        var requestedIds = request.AgentIds!.Distinct().ToList();
        List<RunEntity> created;

        await using (var db = await dbFactory.CreateDbContextAsync())
        {
            var agentIds = await db.Agents
                .Where(a => requestedIds.Contains(a.Id))
                .Select(a => a.Id)
                .ToListAsync();

            created = agentIds.Select(agentId =>
            {
                var online = registry.IsOnline(agentId);
                return new RunEntity
                {
                    Id = Guid.NewGuid().ToString("N"),
                    AgentId = agentId,
                    Shell = request.Shell,
                    CommandLine = request.CommandLine!,
                    WorkingDirectory = string.IsNullOrWhiteSpace(request.WorkingDirectory) ? null : request.WorkingDirectory,
                    TimeoutSeconds = request.TimeoutSeconds,
                    Encoding = string.IsNullOrWhiteSpace(request.Encoding) ? null : request.Encoding,
                    State = online ? RunState.Pending : RunState.Failed,
                    Error = online ? null : "에이전트가 오프라인입니다.",
                    CreatedAt = now,
                    FinishedAt = online ? null : now,
                };
            }).ToList();

            db.Runs.AddRange(created);
            await db.SaveChangesAsync();
        }

        foreach (var run in created)
        {
            if (run.State == RunState.Pending && registry.TryGetConnection(run.AgentId, out var connectionId))
            {
                await agentHub.Clients.Client(connectionId).RunCommand(new RunCommandRequest(
                    run.Id, run.Shell, run.CommandLine, run.WorkingDirectory, run.TimeoutSeconds, run.Encoding, run.JobRunId));
            }
            await dashboard.Clients.All.RunUpdated(run.ToView());
        }

        return created.Select(r => r.ToView()).ToList();
    }

    public async Task MarkStartedAsync(string agentId, CommandStarted started)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        var run = await db.Runs.FirstOrDefaultAsync(r => r.Id == started.RunId && r.AgentId == agentId);
        if (run is null || run.State != RunState.Pending)
            return;

        run.State = RunState.Running;
        run.StartedAt = started.StartedAt;
        await db.SaveChangesAsync();
        await dashboard.Clients.All.RunUpdated(run.ToView());
    }

    public async Task AppendOutputAsync(string agentId, IReadOnlyList<CommandOutput> lines)
    {
        if (lines.Count == 0)
            return;

        var runIds = lines.Select(l => l.RunId).Distinct().ToList();
        List<string> ownedRunIds;
        await using (var db = await dbFactory.CreateDbContextAsync())
        {
            ownedRunIds = await db.Runs
                .Where(r => r.AgentId == agentId && runIds.Contains(r.Id))
                .Select(r => r.Id)
                .ToListAsync();
        }

        foreach (var group in lines.Where(l => ownedRunIds.Contains(l.RunId)).GroupBy(l => l.RunId))
        {
            var batch = group.ToList();
            await logs.AppendAsync(group.Key, batch);
            await dashboard.Clients.Group(DashboardHub.RunGroup(group.Key)).RunOutput(group.Key, batch);
        }
    }

    /// <param name="agentId">null이면 에이전트 확인 없이 서버에서 직접 종료 처리</param>
    public async Task MarkCompletedAsync(string? agentId, CommandCompleted completed)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        var run = await db.Runs.FirstOrDefaultAsync(r => r.Id == completed.RunId && (agentId == null || r.AgentId == agentId));
        if (run is null || IsFinished(run.State))
            return;

        run.State = completed.State;
        run.ExitCode = completed.ExitCode;
        run.Error = completed.Error;
        run.FinishedAt = completed.FinishedAt;
        await db.SaveChangesAsync();
        notifier.Complete(run.Id);
        await dashboard.Clients.All.RunUpdated(run.ToView());
    }

    /// <summary>Job 단계: 한 PC에서 명령을 실행하고 끝날 때까지 기다린다. 취소되면 에이전트에도 취소를 보낸다.</summary>
    public async Task<RunEntity> RunAndWaitAsync(string agentId, string jobRunId, int stepIndex, JobStepDefinition step, CancellationToken ct)
    {
        var online = registry.TryGetConnection(agentId, out var connectionId);
        var now = DateTime.UtcNow;
        var run = new RunEntity
        {
            Id = Guid.NewGuid().ToString("N"),
            AgentId = agentId,
            JobRunId = jobRunId,
            StepIndex = stepIndex,
            Shell = step.Shell,
            CommandLine = step.CommandLine ?? "",
            WorkingDirectory = string.IsNullOrWhiteSpace(step.WorkingDirectory) ? null : step.WorkingDirectory,
            TimeoutSeconds = step.TimeoutSeconds,
            Encoding = string.IsNullOrWhiteSpace(step.Encoding) ? null : step.Encoding,
            State = online ? RunState.Pending : RunState.Failed,
            Error = online ? null : "에이전트가 오프라인입니다.",
            CreatedAt = now,
            FinishedAt = online ? null : now,
        };

        await using (var db = await dbFactory.CreateDbContextAsync(CancellationToken.None))
        {
            db.Runs.Add(run);
            await db.SaveChangesAsync(CancellationToken.None);
        }
        await dashboard.Clients.All.RunUpdated(run.ToView());
        if (!online)
            return run;

        // 완료 신호를 놓치지 않도록 보내기 전에 대기를 등록한다
        var completion = notifier.WaitAsync(run.Id, ct);
        await agentHub.Clients.Client(connectionId).RunCommand(new RunCommandRequest(
            run.Id, run.Shell, run.CommandLine, run.WorkingDirectory, run.TimeoutSeconds, run.Encoding, jobRunId));
        try
        {
            await completion;
        }
        catch (OperationCanceledException)
        {
            await CancelAsync(run.Id);
            throw;
        }

        await using var result = await dbFactory.CreateDbContextAsync(CancellationToken.None);
        return await result.Runs.AsNoTracking().FirstAsync(r => r.Id == run.Id, CancellationToken.None);
    }

    /// <returns>실행이 존재하지 않으면 false</returns>
    public async Task<bool> CancelAsync(string runId)
    {
        RunEntity? run;
        await using (var db = await dbFactory.CreateDbContextAsync())
        {
            run = await db.Runs.AsNoTracking().FirstOrDefaultAsync(r => r.Id == runId);
        }

        if (run is null)
            return false;
        if (IsFinished(run.State))
            return true;

        if (registry.TryGetConnection(run.AgentId, out var connectionId))
        {
            // 에이전트가 실제로 종료한 뒤 ReportCompleted로 상태가 바뀐다
            await agentHub.Clients.Client(connectionId).CancelCommand(runId);
        }
        else
        {
            await MarkCompletedAsync(null, new CommandCompleted(
                runId, RunState.Cancelled, null, "에이전트가 오프라인인 상태에서 취소했습니다.", DateTime.UtcNow));
        }
        return true;
    }

    /// <summary>에이전트 재등록 시, 에이전트가 모르는 대기/실행 중 명령을 실패 처리한다.</summary>
    public async Task FailOrphanedRunsAsync(string agentId, IReadOnlyCollection<string> unreportedRunIds)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        var orphaned = await db.Runs
            .Where(r => r.AgentId == agentId && (r.State == RunState.Pending || r.State == RunState.Running))
            .ToListAsync();
        orphaned.RemoveAll(r => unreportedRunIds.Contains(r.Id));
        if (orphaned.Count == 0)
            return;

        var now = DateTime.UtcNow;
        foreach (var run in orphaned)
        {
            run.State = RunState.Failed;
            run.Error = "에이전트가 재시작되었거나 명령을 받지 못해 결과를 알 수 없습니다.";
            run.FinishedAt = now;
        }
        await db.SaveChangesAsync();

        foreach (var run in orphaned)
        {
            notifier.Complete(run.Id);
            await dashboard.Clients.All.RunUpdated(run.ToView());
        }
    }

    private static bool IsFinished(RunState state) => state is not (RunState.Pending or RunState.Running);
}
