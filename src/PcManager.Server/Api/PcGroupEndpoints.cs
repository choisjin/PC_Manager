using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Server.Services;

namespace PcManager.Server.Api;

public static class PcGroupEndpoints
{
    public static void MapPcGroupApi(this WebApplication app)
    {
        var api = app.MapGroup("/api/pc-groups");

        api.MapGet("/", (PcGroupStore store) => store.Load());

        api.MapPut("/", async (PcGroupsView view, PcGroupStore store, IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            var saved = store.Save(view);
            await dashboard.Clients.All.PcGroupsChanged(saved);
            return Results.Ok(saved);
        });
    }
}
