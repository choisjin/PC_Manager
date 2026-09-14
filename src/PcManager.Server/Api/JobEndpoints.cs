using Microsoft.EntityFrameworkCore;
using PcManager.Server.Contracts;
using PcManager.Server.Data;
using PcManager.Server.Services;

namespace PcManager.Server.Api;

public static class JobEndpoints
{
    public static void MapJobApi(this WebApplication app)
    {
        var api = app.MapGroup("/api/jobs");

        api.MapGet("/", async (int? take, IDbContextFactory<AppDbContext> dbFactory) =>
        {
            await using var db = await dbFactory.CreateDbContextAsync();
            var jobs = await db.JobRuns.AsNoTracking()
                .OrderByDescending(j => j.CreatedAt)
                .Take(Math.Clamp(take ?? 50, 1, 200))
                .ToListAsync();
            return jobs.Select(j => j.ToView());
        });

        api.MapGet("/{id}", async (string id, IDbContextFactory<AppDbContext> dbFactory) =>
        {
            await using var db = await dbFactory.CreateDbContextAsync();
            var job = await db.JobRuns.AsNoTracking().FirstOrDefaultAsync(j => j.Id == id);
            if (job is null)
                return Results.NotFound();

            var targets = await db.JobTargets.AsNoTracking().Where(t => t.JobRunId == id).ToListAsync();
            return Results.Ok(new JobRunDetailView(job.ToView(), targets.Select(t => t.ToView()).ToList()));
        });

        api.MapPost("/", async (CreateJobRequest request, JobService jobs) =>
        {
            if (ValidateSteps(request) is { } error)
                return Results.BadRequest(error);
            if (request.MaxParallel < 0)
                return Results.BadRequest("동시 실행 수는 0 이상이어야 합니다.");

            try
            {
                return Results.Ok(await jobs.StartAsync(request));
            }
            catch (InvalidOperationException ex)
            {
                return Results.BadRequest(ex.Message);
            }
        });

        api.MapPost("/{id}/cancel", async (string id, JobService jobs) =>
            await jobs.CancelAsync(id) ? Results.Accepted() : Results.NotFound());
    }

    private static string? ValidateSteps(CreateJobRequest request)
    {
        if (request.Steps is not { Count: > 0 })
            return "단계를 하나 이상 추가하세요.";

        for (var i = 0; i < request.Steps.Count; i++)
        {
            var step = request.Steps[i];
            if (step.Kind == JobStepKind.Command && string.IsNullOrWhiteSpace(step.CommandLine))
                return $"{i + 1}단계: 명령을 입력하세요.";
            if (step.TimeoutSeconds < 0)
                return $"{i + 1}단계: 제한 시간은 0 이상이어야 합니다.";
        }
        return null;
    }
}
