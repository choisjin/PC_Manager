using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Server.Services;

namespace PcManager.Server.Api;

/// <summary>결과 확인 탭: PC별 결과 폴더 (모든 대시보드 공유, 바뀌면 바로 방송)</summary>
public static class ResultProfileEndpoints
{
    public static void MapResultProfileApi(this WebApplication app)
    {
        var api = app.MapGroup("/api/result-profiles");

        api.MapGet("/", (ResultProfileStore store) => store.Load());

        api.MapPut("/{agentId}", async (string agentId, ResultProfileView profile, HttpRequest http, ResultProfileStore store,
            IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            if (string.IsNullOrWhiteSpace(profile.ResultDir))
                return Results.BadRequest("Result 폴더를 입력하세요.");
            var userId = http.Headers["X-User-Id"].ToString() is { Length: > 0 } id ? id : null;
            var saved = store.Set(agentId, profile, userId);
            await dashboard.Clients.All.ResultProfilesChanged(saved);
            return Results.Ok(saved);
        });

        api.MapDelete("/{agentId}", async (string agentId, ResultProfileStore store, IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            var saved = store.Set(agentId, null, null);
            await dashboard.Clients.All.ResultProfilesChanged(saved);
            return Results.Ok(saved);
        });

        // 결과 폴더 프리셋 (다른 PC에 같은 경로를 골라 바로 적용)
        api.MapPut("/presets/{presetId}", async (string presetId, ResultPresetView preset, HttpRequest http, ResultProfileStore store,
            IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            if (string.IsNullOrWhiteSpace(preset.Name))
                return Results.BadRequest("프리셋 이름을 입력하세요.");
            if (string.IsNullOrWhiteSpace(preset.ResultDir))
                return Results.BadRequest("Result 폴더를 입력하세요.");
            var userId = http.Headers["X-User-Id"].ToString() is { Length: > 0 } id ? id : null;
            var saved = store.SetPreset(presetId, preset, userId);
            await dashboard.Clients.All.ResultProfilesChanged(saved);
            return Results.Ok(saved);
        });

        api.MapDelete("/presets/{presetId}", async (string presetId, ResultProfileStore store, IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            var saved = store.SetPreset(presetId, null, null);
            await dashboard.Clients.All.ResultProfilesChanged(saved);
            return Results.Ok(saved);
        });
    }
}
