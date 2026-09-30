using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Server.Services;

namespace PcManager.Server.Api;

/// <summary>공유 폴더(서버 직접 접근) 등록·조회·삭제</summary>
public static class SharedFolderEndpoints
{
    public static void MapSharedFolderApi(this WebApplication app)
    {
        var api = app.MapGroup("/api/shares");

        api.MapGet("/", (SharedFolderStore store) => Results.Ok(store.Load()));

        api.MapPost("/", async (AddSharedFolderRequest request, SharedFolderStore store, IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            if (string.IsNullOrWhiteSpace(request.Path))
                return Results.BadRequest("공유 폴더 경로를 입력하세요. (예: \\\\서버\\공유폴더 또는 D:\\공유)");
            try
            {
                var share = store.Add(request.Name ?? "", request.Path, request.Username, request.Password);
                await dashboard.Clients.All.SharesChanged(store.Load());
                return Results.Ok(share);
            }
            catch (Exception ex) when (ex is ArgumentException or DirectoryNotFoundException or InvalidOperationException or IOException)
            {
                return Results.BadRequest(ex.Message);
            }
        });

        api.MapDelete("/{id}", async (string id, SharedFolderStore store, IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            var view = store.Remove(id);
            await dashboard.Clients.All.SharesChanged(view);
            return Results.Ok(view);
        });
    }
}
