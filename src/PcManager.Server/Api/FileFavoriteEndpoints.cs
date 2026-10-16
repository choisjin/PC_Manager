using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Server.Services;
using PcManager.Shared;

namespace PcManager.Server.Api;

/// <summary>
/// 사용자별 파일 즐겨찾기 (사이드바 PC 목록 아래): 목록 / 저장 / 지금 열 수 있는지 /
/// 공유 폴더 파일을 내 PC에서 네트워크 경로로 바로 열기 (테스트 PC 파일은 open-local로 연다)
/// </summary>
public static class FileFavoriteEndpoints
{
    private static readonly TimeSpan CheckTimeout = TimeSpan.FromSeconds(10);

    public static void MapFileFavoriteApi(this WebApplication app)
    {
        var api = app.MapGroup("/api/file-favorites");

        api.MapGet("/", (HttpRequest http, FileFavoriteStore store) =>
            UserOf(http) is { } user ? Results.Ok(store.Load(user)) : Results.Ok(new FileFavoritesView([])));

        api.MapPut("/", async (FileFavoritesView view, HttpRequest http, FileFavoriteStore store, IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            if (UserOf(http) is not { } user)
                return Results.BadRequest("로그인한 사용자만 즐겨찾기를 저장할 수 있습니다.");
            var saved = store.Save(user, view.Items);
            // 같은 사용자가 연 다른 대시보드에도
            await dashboard.Clients.Group(ChatEndpoints.UserGroup(user)).FileFavoritesChanged(saved);
            return Results.Ok(saved);
        });

        // 즐겨찾기 id → 지금 열 수 있는지 (PC가 꺼졌거나 파일이 없으면 못 연다)
        api.MapPost("/access", async (HttpRequest http, FileFavoriteStore store, SharedFolderStore shares, LocalShareFiles localShare,
            AgentRegistry registry, IHubContext<AgentHub> agentHub, CancellationToken ct) =>
        {
            if (UserOf(http) is not { } user)
                return Results.Ok(new Dictionary<string, FileFavoriteAccess>());
            var items = store.Load(user).Items;
            var checks = items.Select(async item => (item.Id, Access: await CheckAsync(item, shares, localShare, registry, agentHub, ct)));
            return Results.Ok((await Task.WhenAll(checks)).ToDictionary(x => x.Id, x => x.Access));
        });

        // 공유 폴더 파일: 내 PC 에이전트가 사용자 권한으로 \\서버\… 경로를 그대로 연다 (사본 없음, 저장하면 그 자리에)
        app.MapPost("/api/shares/{shareId}/open-direct", async (string shareId, OpenShareDirectRequest request, SharedFolderStore shares, LocalShareFiles localShare,
            AgentRegistry registry, IHubContext<AgentHub> agentHub, PcLockStore locks, HttpContext context, CancellationToken ct) =>
        {
            if (PcLockEndpoints.Check(context, locks, request.EditorAgentId) is { } locked)
                return locked;
            if (string.IsNullOrWhiteSpace(request.Path) || string.IsNullOrWhiteSpace(request.EditorAgentId))
                return Results.BadRequest("파일 경로와 내 PC가 필요합니다.");
            if (!shares.TryGet(shareId, out var share))
                return Results.NotFound("공유 폴더가 없습니다.");
            if (!SharedFolderStore.IsNetworkPath(share.Path))
                return Results.BadRequest("서버 PC의 로컬 폴더라 내 PC에서 네트워크 경로로 열 수 없습니다.");
            string full;
            try
            {
                full = localShare.ResolveWithin(share, request.Path);
            }
            catch (Exception ex) when (ex is UnauthorizedAccessException or ArgumentException)
            {
                return Results.BadRequest(ex.Message);
            }
            if (!registry.TryGetConnection(request.EditorAgentId!, out var conn))
                return Results.Conflict("내 PC의 에이전트가 오프라인입니다.");
            try
            {
                var error = await agentHub.Clients.Client(conn).InvokeAsync<string?>(AgentClientMethods.LaunchFile, full, ct);
                return error is null ? Results.NoContent() : Results.BadRequest(error);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return Results.Problem(TextEndpoints.OldAgentMessage(ex), statusCode: StatusCodes.Status502BadGateway);
            }
        });
    }

    private static async Task<FileFavoriteAccess> CheckAsync(FileFavorite item, SharedFolderStore shares, LocalShareFiles localShare,
        AgentRegistry registry, IHubContext<AgentHub> agentHub, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(CheckTimeout);
        try
        {
            if (item.IsShare)
            {
                if (!shares.TryGet(item.SourceId, out var share))
                    return new FileFavoriteAccess(false, "공유 폴더가 지워졌습니다.");
                // 응답 없는 네트워크 경로에 오래 묶이지 않게
                var exists = await Task.Run(() => localShare.FileExists(share, item.Path), timeout.Token).WaitAsync(timeout.Token);
                return exists ? new FileFavoriteAccess(true, null) : new FileFavoriteAccess(false, "파일이 없거나 열 수 없습니다.");
            }
            if (!registry.TryGetConnection(item.SourceId, out var conn))
                return new FileFavoriteAccess(false, "PC가 연결되어 있지 않습니다.");
            var size = await agentHub.Clients.Client(conn).InvokeAsync<long>(AgentClientMethods.GetFileSize, item.Path, timeout.Token);
            return size >= 0 ? new FileFavoriteAccess(true, null) : new FileFavoriteAccess(false, "파일이 없거나 열 수 없습니다.");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return new FileFavoriteAccess(false, "응답이 없습니다.");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new FileFavoriteAccess(false, TextEndpoints.OldAgentMessage(ex));
        }
    }

    private static string? UserOf(HttpRequest http) =>
        http.Headers["X-User-Id"].ToString() is { Length: > 0 } id ? id : null;
}
