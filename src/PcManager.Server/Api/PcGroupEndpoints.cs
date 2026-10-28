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

        api.MapPut("/", async (HttpContext http, PcGroupsView view, PcGroupStore store, OrgStore org, IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            var before = (store.Load().Folders ?? []).Select(f => f.Id).ToHashSet();
            var saved = store.Save(view);
            // 새 폴더: PC 목록 폴더 권한이 걸린 사람도 상위 폴더를 볼 수 있으면 함께, 만든 사람(X-User-Id)은 늘 보게
            var creator = http.Request.Headers["X-User-Id"].ToString() is { Length: > 0 } id ? id : null;
            var orgChanged = org.InheritFolders(saved.Folders.Where(f => !before.Contains(f.Id)).ToList(), creator);
            await dashboard.Clients.All.PcGroupsChanged(saved);
            if (orgChanged is not null)
                await dashboard.Clients.All.OrgChanged(orgChanged);
            return Results.Ok(saved);
        });
    }
}
