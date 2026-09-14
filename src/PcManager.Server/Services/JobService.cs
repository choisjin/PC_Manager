using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using PcManager.Server.Contracts;
using PcManager.Server.Data;
using PcManager.Server.Hubs;
using PcManager.Shared;

namespace PcManager.Server.Services;

/// <summary>
/// Job을 실행한다. 한 PC 안에서는 단계를 순서대로, 여러 PC는 MaxParallel만큼 동시에 진행한다.
/// 진행 상태는 서버 메모리에서 관리하므로 서버가 재시작되면 실행 중이던 Job은 실패 처리된다.
/// </summary>
public class JobService(
    IDbContextFactory<AppDbContext> dbFactory,
    RunService runs,
    TransferService transfers,
    IHubContext<DashboardHub, IDashboardClient> dashboard,
    ILogger<JobService> logger)
{
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _running = new();

    public async Task<JobRunDetailView> StartAsync(CreateJobRequest request)
    {
        var now = DateTime.UtcNow;
        JobRunEntity job;
        List<JobTargetEntity> targets;

        await using (var db = await dbFactory.CreateDbContextAsync())
        {
            // 직접 선택한 PC + 태그가 하나라도 맞는 PC
            var selectedIds = new HashSet<string>(request.AgentIds ?? []);
            var tags = request.Tags ?? [];
            var agents = await db.Agents.AsNoTracking().OrderBy(a => a.MachineName).ToListAsync();
            var agentIds = agents
                .Where(a => selectedIds.Contains(a.Id) || a.Tags.Any(t => tags.Contains(t, StringComparer.OrdinalIgnoreCase)))
                .Select(a => a.Id)
                .ToList();
            if (agentIds.Count == 0)
                throw new InvalidOperationException("대상 PC가 없습니다.");

            job = new JobRunEntity
            {
                Id = Guid.NewGuid().ToString("N"),
                Name = string.IsNullOrWhiteSpace(request.Name) ? $"Job {DateTime.Now:yyyy-MM-dd HH:mm:ss}" : request.Name.Trim(),
                Steps = [.. request.Steps!],
                MaxParallel = Math.Max(0, request.MaxParallel),
                State = JobState.Running,
                CreatedAt = now,
            };
            targets = agentIds
                .Select(agentId => new JobTargetEntity { JobRunId = job.Id, AgentId = agentId, State = JobState.Pending })
                .ToList();

            db.JobRuns.Add(job);
            db.JobTargets.AddRange(targets);
            await db.SaveChangesAsync();
        }

        await dashboard.Clients.All.JobRunUpdated(job.ToView());
        foreach (var target in targets)
            await dashboard.Clients.All.JobTargetUpdated(target.ToView());

        var cancel = new CancellationTokenSource();
        _running[job.Id] = cancel;
        var steps = job.Steps;
        var ids = targets.Select(t => t.AgentId).ToList();
        _ = Task.Run(() => ExecuteAsync(job.Id, steps, ids, job.MaxParallel, cancel));

        return new JobRunDetailView(job.ToView(), targets.Select(t => t.ToView()).ToList());
    }

    /// <returns>실행 중이 아니고 존재하지도 않으면 false</returns>
    public async Task<bool> CancelAsync(string jobRunId)
    {
        if (_running.TryGetValue(jobRunId, out var cancel))
        {
            try
            {
                cancel.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // 방금 끝남
            }
            return true;
        }

        await using var db = await dbFactory.CreateDbContextAsync();
        return await db.JobRuns.AnyAsync(j => j.Id == jobRunId);
    }

    /// <summary>서버 시작 시: 이전 프로세스에서 실행 중이던 Job을 실패 처리한다.</summary>
    public async Task RecoverInterruptedAsync()
    {
        const string message = "서버가 재시작되어 중단되었습니다.";
        var now = DateTime.UtcNow;
        await using var db = await dbFactory.CreateDbContextAsync();

        var jobs = await db.JobRuns.Where(j => j.State == JobState.Pending || j.State == JobState.Running).ToListAsync();
        foreach (var job in jobs)
        {
            job.State = JobState.Failed;
            job.FinishedAt = now;
        }

        var targets = await db.JobTargets.Where(t => t.State == JobState.Pending || t.State == JobState.Running).ToListAsync();
        foreach (var target in targets)
        {
            target.State = JobState.Failed;
            target.Error = message;
            target.FinishedAt = now;
        }

        await db.SaveChangesAsync();
        if (jobs.Count > 0)
            logger.LogWarning("중단된 Job {Count}개를 실패 처리했습니다.", jobs.Count);
    }

    private async Task ExecuteAsync(
        string jobRunId, List<JobStepDefinition> steps, List<string> agentIds, int maxParallel, CancellationTokenSource cancel)
    {
        var finalState = JobState.Failed;
        try
        {
            var options = new ParallelOptions { MaxDegreeOfParallelism = maxParallel > 0 ? maxParallel : agentIds.Count };
            await Parallel.ForEachAsync(agentIds, options,
                async (agentId, _) => await ExecuteTargetAsync(jobRunId, agentId, steps, cancel.Token));

            await using var db = await dbFactory.CreateDbContextAsync();
            var states = await db.JobTargets.Where(t => t.JobRunId == jobRunId).Select(t => t.State).ToListAsync();
            finalState = cancel.IsCancellationRequested ? JobState.Cancelled
                : states.All(s => s == JobState.Succeeded) ? JobState.Succeeded
                : JobState.Failed;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Job 실행 오류 {JobRunId}", jobRunId);
        }
        finally
        {
            _running.TryRemove(jobRunId, out _);
            cancel.Dispose();
        }

        await using (var db = await dbFactory.CreateDbContextAsync())
        {
            var job = await db.JobRuns.FirstAsync(j => j.Id == jobRunId);
            job.State = finalState;
            job.FinishedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
            await dashboard.Clients.All.JobRunUpdated(job.ToView());
        }
        logger.LogInformation("Job 종료 {JobRunId}: {State}", jobRunId, finalState);
    }

    private async Task ExecuteTargetAsync(string jobRunId, string agentId, List<JobStepDefinition> steps, CancellationToken ct)
    {
        if (ct.IsCancellationRequested)
        {
            await UpdateTargetAsync(jobRunId, agentId, t =>
            {
                t.State = JobState.Cancelled;
                t.FinishedAt = DateTime.UtcNow;
            });
            return;
        }

        await UpdateTargetAsync(jobRunId, agentId, t =>
        {
            t.State = JobState.Running;
            t.StartedAt = DateTime.UtcNow;
        });

        string? firstError = null;
        try
        {
            for (var index = 0; index < steps.Count; index++)
            {
                ct.ThrowIfCancellationRequested();
                var step = steps[index];
                var stepIndex = index;
                await UpdateTargetAsync(jobRunId, agentId, t => t.CurrentStep = stepIndex);

                var error = step.Kind == JobStepKind.Collect
                    ? await CollectStepAsync(jobRunId, agentId, index, step, ct)
                    : await CommandStepAsync(jobRunId, agentId, index, step, ct);
                if (error is null)
                    continue;

                firstError ??= $"{index + 1}단계({StepLabel(step)}) 실패: {error}";
                // 실패해도 다음 단계는 진행하지만 PC 결과는 실패로 남긴다
                if (!step.ContinueOnError)
                    break;
            }

            await UpdateTargetAsync(jobRunId, agentId, t =>
            {
                t.State = firstError is null ? JobState.Succeeded : JobState.Failed;
                t.Error = firstError;
                t.FinishedAt = DateTime.UtcNow;
            });
        }
        catch (OperationCanceledException)
        {
            await UpdateTargetAsync(jobRunId, agentId, t =>
            {
                t.State = JobState.Cancelled;
                t.Error = firstError;
                t.FinishedAt = DateTime.UtcNow;
            });
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Job 대상 실행 오류 {JobRunId}/{AgentId}", jobRunId, agentId);
            await UpdateTargetAsync(jobRunId, agentId, t =>
            {
                t.State = JobState.Failed;
                t.Error = firstError ?? ex.Message;
                t.FinishedAt = DateTime.UtcNow;
            });
        }
    }

    /// <returns>실패 사유. 성공이면 null</returns>
    private async Task<string?> CommandStepAsync(string jobRunId, string agentId, int index, JobStepDefinition step, CancellationToken ct)
    {
        var run = await runs.RunAndWaitAsync(agentId, jobRunId, index, step, ct);
        return run.State switch
        {
            RunState.Succeeded => null,
            RunState.TimedOut => "제한 시간 초과",
            RunState.Cancelled => "취소됨",
            _ => run.Error ?? $"종료 코드 {run.ExitCode}",
        };
    }

    /// <returns>실패 사유. 성공이면 null</returns>
    private async Task<string?> CollectStepAsync(string jobRunId, string agentId, int index, JobStepDefinition step, CancellationToken ct)
    {
        var sourceDirectory = string.IsNullOrWhiteSpace(step.SourceDirectory) ? null : step.SourceDirectory;
        var transfer = await transfers.CollectAndWaitAsync(agentId, jobRunId, index, sourceDirectory, step.Patterns, ct);
        if (transfer.State != TransferState.Succeeded)
            return transfer.Error ?? "결과 수집 실패";

        // 지금까지 수집된 JUnit XML 합계를 PC 결과에 반영
        await using var db = await dbFactory.CreateDbContextAsync(CancellationToken.None);
        var junit = await db.Artifacts
            .Where(a => a.JobRunId == jobRunId && a.AgentId == agentId && a.TestsTotal != null)
            .ToListAsync(CancellationToken.None);
        if (junit.Count > 0)
        {
            await UpdateTargetAsync(jobRunId, agentId, t =>
            {
                t.TestsTotal = junit.Sum(a => a.TestsTotal);
                t.TestsFailed = junit.Sum(a => a.TestsFailed);
                t.TestsSkipped = junit.Sum(a => a.TestsSkipped);
            });
        }
        return null;
    }

    private async Task UpdateTargetAsync(string jobRunId, string agentId, Action<JobTargetEntity> update)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        var target = await db.JobTargets.FirstAsync(t => t.JobRunId == jobRunId && t.AgentId == agentId);
        update(target);
        await db.SaveChangesAsync();
        await dashboard.Clients.All.JobTargetUpdated(target.ToView());
    }

    private static string StepLabel(JobStepDefinition step) =>
        !string.IsNullOrWhiteSpace(step.Name) ? step.Name
        : step.Kind == JobStepKind.Collect ? "결과 수집"
        : "명령 실행";
}
