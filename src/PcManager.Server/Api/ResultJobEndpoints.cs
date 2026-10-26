using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Server.Services;
using PcManager.Shared;

namespace PcManager.Server.Api;

/// <summary>
/// 결과 확인 작업(영상 분석·이미지 찾기) 목록: 웹이 시작하면 적어 두고, 진행은 ResultJobPoller가 채운다.
/// 예약 분석: 시각이 되면 ResultScheduler가 시작해 작업으로 적는다
/// </summary>
public static class ResultJobEndpoints
{
    public static void MapResultJobApi(this WebApplication app)
    {
        var api = app.MapGroup("/api/result-jobs");

        api.MapGet("/", (ResultJobStore store) => store.List());

        api.MapPost("/", async (RegisterResultJobRequest request, HttpRequest http, ResultJobStore store,
            IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            if (string.IsNullOrWhiteSpace(request.Id) || !ResultJobKinds.All.Contains(request.Kind) || string.IsNullOrWhiteSpace(request.AgentId))
                return Results.BadRequest("작업 id·종류·PC가 필요합니다.");
            var view = store.Register(request, UserId(http));
            await dashboard.Clients.All.ResultJobsChanged(store.List());
            return Results.Ok(view);
        });

        // 다시 열 때 되살릴 웹 설정 (바꾸면 다시 적는다)
        api.MapGet("/{id}/params", (string id, ResultJobStore store) =>
            store.GetParams(id) is { } value ? Results.Ok(value) : Results.NotFound());
        api.MapPut("/{id}/params", (string id, JsonElement value, ResultJobStore store) =>
            store.SetParams(id, value) ? Results.NoContent() : Results.NotFound());

        api.MapPost("/{id}/seen", async (string id, ResultJobStore store, IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            if (store.MarkSeen(id))
                await dashboard.Clients.All.ResultJobsChanged(store.List());
            return Results.NoContent();
        });

        var schedules = app.MapGroup("/api/result-schedules");
        schedules.MapGet("/", (ResultScheduleStore store) => store.List());
        schedules.MapPost("/", async (CreateResultScheduleRequest request, HttpRequest http, ResultScheduleStore store,
            IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            if (string.IsNullOrWhiteSpace(request.AgentId) || request.Videos is not { Count: > 0 })
                return Results.BadRequest("PC와 영상이 필요합니다.");
            if (request.Analysis is null && request.Search is null)
                return Results.BadRequest("예약할 분석(영상 분석·이미지 찾기)이 없습니다.");
            var view = store.Add(request, UserId(http));
            await dashboard.Clients.All.ResultSchedulesChanged(store.List());
            return Results.Ok(view);
        });
        schedules.MapDelete("/{id}", async (string id, ResultScheduleStore store, IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            if (store.Remove(id))
                await dashboard.Clients.All.ResultSchedulesChanged(store.List());
            return Results.NoContent();
        });

        // 목록에서 빼기: 돌고 있으면 에이전트에서도 멈춘다
        api.MapDelete("/{id}", async (string id, ResultJobStore store, AgentRegistry registry, IHubContext<AgentHub> agentHub,
            IHubContext<DashboardHub, IDashboardClient> dashboard, CancellationToken ct) =>
        {
            if (store.Get(id) is { State: "running" } job && registry.TryGetConnection(job.AgentId, out var connectionId))
            {
                try
                {
                    await agentHub.Clients.Client(connectionId).InvokeAsync<bool>(
                        job.Kind == ResultJobKinds.Analysis ? AgentClientMethods.CancelVideoAnalysis : AgentClientMethods.CancelImageSearch, id, ct);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // 목록에서는 뺀다
                }
            }
            if (store.Remove(id) is not null)
                await dashboard.Clients.All.ResultJobsChanged(store.List());
            return Results.NoContent();
        });
    }

    private static string? UserId(HttpRequest request)
    {
        var value = request.Headers["X-User-Id"].ToString();
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }
}
