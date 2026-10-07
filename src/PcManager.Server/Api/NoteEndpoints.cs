using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Server.Services;

namespace PcManager.Server.Api;

/// <summary>
/// 메모 API. 요청한 사용자는 X-User-Id 헤더.
/// 공유 메모 변경은 모든 대시보드에, 개인 메모 변경은 그 사용자의 대시보드(Hub 그룹 "chat:사용자id")에만 알린다.
/// </summary>
public static class NoteEndpoints
{
    public static void MapNoteApi(this WebApplication app)
    {
        var api = app.MapGroup("/api/notes");

        api.MapGet("/", (HttpRequest http, NoteStore store) =>
            UserOf(http) is { } user ? Results.Ok(store.ListFor(user)) : Results.Ok(Array.Empty<NoteView>()));

        api.MapPost("/", async (CreateNoteRequest request, HttpRequest http, NoteStore store, IHubContext<DashboardHub, IDashboardClient> hub) =>
            await RunAsync(http, async user =>
            {
                var note = store.Create(user, request.Scope ?? NoteStore.Shared);
                await PushChangedAsync(hub, note);
                return Results.Ok(note);
            }));

        api.MapPut("/{id}", async (string id, UpdateNoteRequest request, HttpRequest http, NoteStore store, IHubContext<DashboardHub, IDashboardClient> hub) =>
            await RunAsync(http, async user =>
            {
                try
                {
                    var note = store.Update(user, id, request.Title, request.Content, request.BaseUpdatedAt);
                    await PushChangedAsync(hub, note);
                    return Results.Ok(note);
                }
                catch (NoteConflictException ex)
                {
                    // 최신 내용을 돌려줘 대시보드가 고를 수 있게 한다
                    return Results.Conflict(ex.Current);
                }
            }));

        api.MapDelete("/{id}", async (string id, HttpRequest http, NoteStore store, IHubContext<DashboardHub, IDashboardClient> hub) =>
            await RunAsync(http, async user =>
            {
                var note = store.Delete(user, id);
                await (note.Scope == NoteStore.Shared
                    ? hub.Clients.All.NoteRemoved(id)
                    : hub.Clients.Group(ChatEndpoints.UserGroup(note.OwnerId)).NoteRemoved(id));
                return Results.NoContent();
            }));

        // 이미지: 본문 그대로 (Content-Type: image/*). 대시보드가 적당한 크기로 줄여서 올린다
        api.MapPost("/images", async (HttpRequest http, NoteStore store, CancellationToken ct) =>
            await RunAsync(http, async _ => Results.Ok(new NoteImageView(await store.SaveImageAsync(http.Body, http.ContentType, ct)))))
            .WithMetadata(new Microsoft.AspNetCore.Mvc.RequestSizeLimitAttribute(16 * 1024 * 1024));

        // 이름이 무작위라 바뀌지 않는다 → 오래 캐시
        api.MapGet("/images/{name}", (string name, HttpResponse response, NoteStore store) =>
        {
            if (store.FindImage(name) is not { } image)
                return Results.NotFound();
            response.Headers.CacheControl = "private, max-age=31536000, immutable";
            return Results.File(image.Path, image.ContentType);
        });
    }

    private static Task PushChangedAsync(IHubContext<DashboardHub, IDashboardClient> hub, NoteView note) =>
        note.Scope == NoteStore.Shared
            ? hub.Clients.All.NoteChanged(note)
            : hub.Clients.Group(ChatEndpoints.UserGroup(note.OwnerId)).NoteChanged(note);

    private static string? UserOf(HttpRequest http) =>
        http.Headers["X-User-Id"].ToString() is { Length: > 0 } id ? id : null;

    private static async Task<IResult> RunAsync(HttpRequest http, Func<string, Task<IResult>> work)
    {
        if (UserOf(http) is not { } user)
            return Results.BadRequest("사용자를 선택(로그인)해야 메모를 쓸 수 있습니다.");
        try
        {
            return await work(user);
        }
        catch (Exception ex) when (ex is ArgumentException or KeyNotFoundException)
        {
            return Results.BadRequest(ex.Message);
        }
    }
}
