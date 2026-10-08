using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Server.Services;

namespace PcManager.Server.Api;

public static class StateLayoutEndpoints
{
    public static void MapStateLayoutApi(this WebApplication app)
    {
        var api = app.MapGroup("/api/state-layout");

        api.MapGet("/", (StateLayoutStore store) => store.Load());

        // 누가 옮기거나 고정하면 모든 대시보드에 바로 반영
        api.MapPut("/", async (StateLayoutView view, StateLayoutStore store, IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            var saved = store.Save(view);
            await dashboard.Clients.All.StateLayoutChanged(saved);
            return Results.Ok(saved);
        });
    }
}
