using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Services;
using PcManager.Shared;

namespace PcManager.Server.Hubs;

/// <summary>서버 → 대시보드 호출</summary>
public interface IDashboardClient
{
    Task AgentUpdated(AgentView agent);
    Task RunUpdated(RunView run);
    Task RunOutput(string runId, IReadOnlyList<CommandOutput> lines);
    Task TransferUpdated(TransferView transfer);
    Task JobRunUpdated(JobRunView job);
    Task JobTargetUpdated(JobTargetView target);
    Task UpdateStatusChanged(UpdateStatusView status);
    Task PcGroupsChanged(PcGroupsView groups);
    Task PcFavoritesChanged(PcFavoritesView favorites);
    Task SharesChanged(SharedFoldersView shares);
    Task OrgChanged(OrgView org);
    Task PresenceChanged(IReadOnlyDictionary<string, IReadOnlyList<string>> viewers);
    Task PcStatusesChanged(PcStatusesView statuses);
    Task RemoteUsageChanged(RemoteUsageView usage);
    Task ChatRoomChanged(ChatRoomView room);
    Task ChatRoomRemoved(string roomId);
    Task ChatRoomMessage(ChatRoomMessageView message);
    Task ChatRoomRead(string roomId, string userId, long messageId);
    Task ThumbnailUpdated(ThumbnailView thumbnail);
}

/// <summary>웹 대시보드가 접속하는 Hub. 출력은 보고 있는 실행에만 전달한다.</summary>
public class DashboardHub(PresenceRegistry presence, ThumbnailService thumbnails) : Hub<IDashboardClient>
{
    /// <summary>이 접속이 받을 채팅 사용자 (그 사용자가 속한 방의 메시지·변경만 받는다). 사용자를 바꾸면 다시 부른다</summary>
    public async Task JoinChat(string? previousUserId, string? userId)
    {
        if (!string.IsNullOrWhiteSpace(previousUserId))
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, Api.ChatEndpoints.UserGroup(previousUserId));
        if (!string.IsNullOrWhiteSpace(userId))
            await Groups.AddToGroupAsync(Context.ConnectionId, Api.ChatEndpoints.UserGroup(userId));
    }

    /// <summary>Remote 화면에서 보고 싶은 PC 목록 (빈 목록이면 구독 해제). 마지막 썸네일은 바로 보내 준다</summary>
    public async Task WatchThumbnails(IReadOnlyList<string> agentIds)
    {
        var ids = agentIds ?? [];
        if (ids.Count == 0)
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, ThumbnailService.Group);
        else
            await Groups.AddToGroupAsync(Context.ConnectionId, ThumbnailService.Group);
        thumbnails.SetWants(Context.ConnectionId, ids);
        foreach (var t in thumbnails.Latest.Where(t => ids.Contains(t.AgentId)))
            await Clients.Caller.ThumbnailUpdated(t);
    }

    public static string RunGroup(string runId) => $"run:{runId}";

    public Task WatchRun(string runId) => Groups.AddToGroupAsync(Context.ConnectionId, RunGroup(runId));

    public Task UnwatchRun(string runId) => Groups.RemoveFromGroupAsync(Context.ConnectionId, RunGroup(runId));

    /// <summary>이 접속(사용자)이 지금 보고 있는 PC 목록을 알린다.</summary>
    public async Task SetPresence(string userId, IReadOnlyList<string> agentIds)
    {
        presence.Set(Context.ConnectionId, userId, agentIds ?? []);
        await Clients.All.PresenceChanged(presence.Snapshot());
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        presence.Remove(Context.ConnectionId);
        thumbnails.RemoveConnection(Context.ConnectionId);
        await Clients.All.PresenceChanged(presence.Snapshot());
        await base.OnDisconnectedAsync(exception);
    }
}
