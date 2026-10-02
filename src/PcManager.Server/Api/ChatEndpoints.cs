using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Server.Services;

namespace PcManager.Server.Api;

/// <summary>
/// 채팅방(1:1·그룹) API. 요청한 사용자는 X-User-Id 헤더.
/// 메시지·방 변경은 그 방 구성원의 대시보드에만 보낸다 (Hub 그룹 "chat:사용자id").
/// </summary>
public static class ChatEndpoints
{
    public static string UserGroup(string userId) => $"chat:{userId}";

    public static void MapChatApi(this WebApplication app)
    {
        var api = app.MapGroup("/api/chat");

        api.MapGet("/rooms", (HttpRequest http, ChatRoomStore store) =>
            UserOf(http) is { } user ? Results.Ok(store.RoomsFor(user)) : Results.Ok(Array.Empty<ChatRoomView>()));

        api.MapGet("/rooms/{roomId}/messages", (string roomId, int? take, HttpRequest http, ChatRoomStore store) =>
            Run(http, user => Results.Ok(store.Messages(roomId, user, Math.Clamp(take ?? 200, 1, 500)))));

        // 그룹 방 만들기 (이름 + 처음 초대할 사람)
        api.MapPost("/rooms", async (CreateGroupChatRequest request, HttpRequest http, ChatRoomStore store, OrgStore org, IHubContext<DashboardHub, IDashboardClient> hub) =>
            await RunAsync(http, async user =>
            {
                var room = store.CreateGroup(user, request.Name ?? "", request.MemberIds ?? []);
                await PushRoomAsync(hub, store, room.Id);
                return Results.Ok(room);
            }));

        // 1:1 대화 열기 (없으면 만든다)
        api.MapPost("/direct", async (OpenDirectChatRequest request, HttpRequest http, ChatRoomStore store, IHubContext<DashboardHub, IDashboardClient> hub) =>
            await RunAsync(http, async user =>
            {
                var room = store.OpenDirect(user, request.UserId ?? "");
                await PushRoomAsync(hub, store, room.Id);
                return Results.Ok(room);
            }));

        api.MapPost("/rooms/{roomId}/invite", async (string roomId, InviteChatRequest request, HttpRequest http, ChatRoomStore store, OrgStore org, IHubContext<DashboardHub, IDashboardClient> hub) =>
            await RunAsync(http, async user =>
            {
                var (room, notice, _) = store.Invite(user, roomId, request.UserIds ?? [], NameOf(org));
                await PushRoomAsync(hub, store, roomId);
                if (notice is not null)
                    await PushMessageAsync(hub, store, notice);
                return Results.Ok(room);
            }));

        api.MapPost("/rooms/{roomId}/kick/{targetId}", async (string roomId, string targetId, HttpRequest http, ChatRoomStore store, OrgStore org, IHubContext<DashboardHub, IDashboardClient> hub) =>
            await RunAsync(http, async user =>
            {
                var (room, notice) = store.Kick(user, roomId, targetId, NameOf(org));
                await hub.Clients.Group(UserGroup(targetId)).ChatRoomRemoved(roomId);
                await PushRoomAsync(hub, store, roomId);
                await PushMessageAsync(hub, store, notice);
                return Results.Ok(room);
            }));

        api.MapPost("/rooms/{roomId}/leave", async (string roomId, HttpRequest http, ChatRoomStore store, OrgStore org, IHubContext<DashboardHub, IDashboardClient> hub) =>
            await RunAsync(http, async user =>
            {
                var (room, notice) = store.Leave(user, roomId, NameOf(org));
                await hub.Clients.Group(UserGroup(user)).ChatRoomRemoved(roomId);
                if (room is not null)
                {
                    await PushRoomAsync(hub, store, roomId);
                    if (notice is not null)
                        await PushMessageAsync(hub, store, notice);
                }
                return Results.NoContent();
            }));

        api.MapPut("/rooms/{roomId}/name", async (string roomId, RenameChatRequest request, HttpRequest http, ChatRoomStore store, OrgStore org, IHubContext<DashboardHub, IDashboardClient> hub) =>
            await RunAsync(http, async user =>
            {
                var (room, notice) = store.Rename(user, roomId, request.Name ?? "", NameOf(org));
                await PushRoomAsync(hub, store, roomId);
                await PushMessageAsync(hub, store, notice);
                return Results.Ok(room);
            }));

        api.MapPost("/rooms/{roomId}/messages", async (string roomId, SendChatRequest request, HttpRequest http, ChatRoomStore store, IHubContext<DashboardHub, IDashboardClient> hub) =>
            await RunAsync(http, async user =>
            {
                var message = store.Send(user, roomId, request.Text ?? "", request.Mentions);
                await PushMessageAsync(hub, store, message);
                await PushReadAsync(hub, store, roomId, user, message.Id);
                return Results.Ok(message);
            }));

        api.MapPost("/rooms/{roomId}/read", async (string roomId, ReadChatRequest request, HttpRequest http, ChatRoomStore store, IHubContext<DashboardHub, IDashboardClient> hub) =>
            await RunAsync(http, async user =>
            {
                if (store.MarkRead(user, roomId, request.MessageId))
                    await PushReadAsync(hub, store, roomId, user, request.MessageId);
                return Results.NoContent();
            }));
    }

    private static string? UserOf(HttpRequest http) =>
        http.Headers["X-User-Id"].ToString() is { Length: > 0 } id ? id : null;

    private static Func<string, string> NameOf(OrgStore org)
    {
        var users = org.Load().Users.ToDictionary(u => u.Id, u => u.Name);
        return id => users.TryGetValue(id, out var name) ? name : "(삭제된 사용자)";
    }

    private static IResult Run(HttpRequest http, Func<string, IResult> work)
    {
        if (UserOf(http) is not { } user)
            return Results.BadRequest("사용자를 선택(로그인)해야 채팅할 수 있습니다.");
        try
        {
            return work(user);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or KeyNotFoundException)
        {
            return Results.BadRequest(ex.Message);
        }
    }

    private static async Task<IResult> RunAsync(HttpRequest http, Func<string, Task<IResult>> work)
    {
        if (UserOf(http) is not { } user)
            return Results.BadRequest("사용자를 선택(로그인)해야 채팅할 수 있습니다.");
        try
        {
            return await work(user);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or KeyNotFoundException)
        {
            return Results.BadRequest(ex.Message);
        }
    }

    private static IReadOnlyList<string> MemberGroups(ChatRoomStore store, string roomId) =>
        store.MembersOf(roomId).Select(UserGroup).ToList();

    /// <summary>방 정보(구성원·이름 등)를 구성원 각자에게 (안 읽은 수가 사람마다 달라 따로 보낸다)</summary>
    private static async Task PushRoomAsync(IHubContext<DashboardHub, IDashboardClient> hub, ChatRoomStore store, string roomId)
    {
        foreach (var member in store.MembersOf(roomId))
            if (store.RoomFor(roomId, member) is { } view)
                await hub.Clients.Group(UserGroup(member)).ChatRoomChanged(view);
    }

    private static Task PushMessageAsync(IHubContext<DashboardHub, IDashboardClient> hub, ChatRoomStore store, ChatRoomMessageView message) =>
        hub.Clients.Groups(MemberGroups(store, message.RoomId)).ChatRoomMessage(message);

    private static Task PushReadAsync(IHubContext<DashboardHub, IDashboardClient> hub, ChatRoomStore store, string roomId, string userId, long messageId) =>
        hub.Clients.Groups(MemberGroups(store, roomId)).ChatRoomRead(roomId, userId, messageId);
}
