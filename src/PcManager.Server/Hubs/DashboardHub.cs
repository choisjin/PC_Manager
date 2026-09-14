using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
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
}

/// <summary>웹 대시보드가 접속하는 Hub. 출력은 보고 있는 실행에만 전달한다.</summary>
public class DashboardHub : Hub<IDashboardClient>
{
    public static string RunGroup(string runId) => $"run:{runId}";

    public Task WatchRun(string runId) => Groups.AddToGroupAsync(Context.ConnectionId, RunGroup(runId));

    public Task UnwatchRun(string runId) => Groups.RemoveFromGroupAsync(Context.ConnectionId, RunGroup(runId));
}
