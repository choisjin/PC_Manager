using Microsoft.EntityFrameworkCore;
using PcManager.Server.Contracts;
using PcManager.Server.Data;
using PcManager.Server.Services;

namespace PcManager.Server.Api;

public static class ApiEndpoints
{
    public static void MapApi(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/agents", async (IDbContextFactory<AppDbContext> dbFactory, AgentRegistry registry) =>
        {
            await using var db = await dbFactory.CreateDbContextAsync();
            var agents = await db.Agents.AsNoTracking().OrderBy(a => a.MachineName).ToListAsync();
            return agents.Select(a => a.ToView(registry.IsOnline(a.Id)));
        });

        api.MapGet("/runs", async (string? agentId, string? jobRunId, int? take, IDbContextFactory<AppDbContext> dbFactory) =>
        {
            await using var db = await dbFactory.CreateDbContextAsync();
            var query = db.Runs.AsNoTracking();
            if (!string.IsNullOrEmpty(agentId))
                query = query.Where(r => r.AgentId == agentId);
            if (!string.IsNullOrEmpty(jobRunId))
                query = query.Where(r => r.JobRunId == jobRunId);

            var runs = await query
                .OrderByDescending(r => r.CreatedAt)
                .Take(Math.Clamp(take ?? 100, 1, 500))
                .ToListAsync();
            return runs.Select(r => r.ToView());
        });

        api.MapGet("/runs/{id}", async (string id, IDbContextFactory<AppDbContext> dbFactory) =>
        {
            await using var db = await dbFactory.CreateDbContextAsync();
            var run = await db.Runs.AsNoTracking().FirstOrDefaultAsync(r => r.Id == id);
            return run is null ? Results.NotFound() : Results.Ok(run.ToView());
        });

        api.MapGet("/runs/{id}/output", async (string id, long? afterSeq, RunLogStore logs) =>
        {
            if (!Guid.TryParseExact(id, "N", out _))
                return Results.NotFound();
            return Results.Ok(await logs.ReadAsync(id, afterSeq ?? 0));
        });

        api.MapPost("/runs", async (CreateRunsRequest request, RunService runs) =>
        {
            if (request.AgentIds is not { Count: > 0 })
                return Results.BadRequest("실행할 PC를 선택하세요.");
            if (string.IsNullOrWhiteSpace(request.CommandLine))
                return Results.BadRequest("명령을 입력하세요.");
            if (request.TimeoutSeconds < 0)
                return Results.BadRequest("제한 시간은 0 이상이어야 합니다.");

            return Results.Ok(await runs.CreateAsync(request));
        });

        api.MapPost("/runs/{id}/cancel", async (string id, RunService runs) =>
            await runs.CancelAsync(id) ? Results.Accepted() : Results.NotFound());
    }
}
