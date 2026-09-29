using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Server.Services;

namespace PcManager.Server.Api;

public static class PcFavoriteEndpoints
{
    public static void MapPcFavoriteApi(this WebApplication app)
    {
        var api = app.MapGroup("/api/pc-favorites");

        api.MapGet("/", (PcFavoriteStore store) => store.Load());

        api.MapPut("/", async (PcFavoritesView view, PcFavoriteStore store, IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            var saved = store.Save(view);
            await dashboard.Clients.All.PcFavoritesChanged(saved);
            return Results.Ok(saved);
        });
    }
}
