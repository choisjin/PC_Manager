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

        // 요청한 사용자(X-User-Id)의 공유 폴더만
        api.MapGet("/", (HttpRequest http, SharedFolderStore store) => Results.Ok(store.Load(UserOf(http))));

        api.MapPost("/", async (AddSharedFolderRequest request, HttpRequest http, SharedFolderStore store, IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            if (string.IsNullOrWhiteSpace(request.Path))
                return Results.BadRequest("공유 폴더 경로를 입력하세요. (예: \\\\서버\\공유폴더 또는 D:\\공유)");
            try
            {
                var share = store.Add(UserOf(http), request.Name ?? "", request.Path, request.Username, request.Password);
                await NotifyAsync(dashboard);
                return Results.Ok(share);
            }
            catch (Exception ex) when (ex is ArgumentException or DirectoryNotFoundException or InvalidOperationException or IOException)
            {
                return Results.BadRequest(ex.Message);
            }
        });

        // 등록 전 확인: 자격증명 없이 열리는지 (등록 화면이 사용자 이름을 필수로 할지 정함)
        api.MapPost("/probe", (ShareProbeRequest request) =>
            Results.Ok(SharedFolderStore.Probe(request.Path ?? "")));

        // 표시 순서 변경 (끌어서 옮기기)
        api.MapPut("/order", async (ReorderSharedFoldersRequest request, HttpRequest http, SharedFolderStore store, IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            var view = store.Reorder(UserOf(http), request.Ids ?? []);
            await NotifyAsync(dashboard);
            return Results.Ok(view);
        });

        // 별칭(표시 이름) 변경
        api.MapPut("/{id}/name", async (string id, RenameSharedFolderRequest request, HttpRequest http, SharedFolderStore store, IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            try
            {
                var share = store.Rename(UserOf(http), id, request.Name ?? "");
                await NotifyAsync(dashboard);
                return Results.Ok(share);
            }
            catch (Exception ex) when (ex is ArgumentException or KeyNotFoundException)
            {
                return Results.BadRequest(ex.Message);
            }
        });

        api.MapDelete("/{id}", async (string id, HttpRequest http, SharedFolderStore store, IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            store.Remove(UserOf(http), id);
            await NotifyAsync(dashboard);
            return Results.Ok(store.Load(UserOf(http)));
        });
    }

    private static string? UserOf(HttpRequest http) =>
        http.Headers["X-User-Id"].ToString() is { Length: > 0 } id ? id : null;

    // 사용자마다 목록이 달라 내용은 보내지 않는다. 받으면 각 대시보드가 자기 목록을 다시 불러온다
    private static Task NotifyAsync(IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        dashboard.Clients.All.SharesChanged(new SharedFoldersView([]));
}
