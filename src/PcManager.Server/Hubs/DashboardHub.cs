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
    Task ChatMessage(ChatMessageView message);
}

/// <summary>웹 대시보드가 접속하는 Hub. 출력은 보고 있는 실행에만 전달한다.</summary>
public class DashboardHub(PresenceRegistry presence, ChatStore chat) : Hub<IDashboardClient>
{
    /// <summary>사용자 간 채팅 메시지 (모든 대시보드에 전달)</summary>
    public async Task SendChat(string userId, string text)
    {
        if (string.IsNullOrWhiteSpace(userId) || string.IsNullOrWhiteSpace(text))
            return;
        var message = chat.Add(userId, text);
        await Clients.All.ChatMessage(message);
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
        await Clients.All.PresenceChanged(presence.Snapshot());
        await base.OnDisconnectedAsync(exception);
    }
}
