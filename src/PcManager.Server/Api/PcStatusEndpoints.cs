using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Server.Services;

namespace PcManager.Server.Api;

/// <summary>PC 수동 상태(테스트 중/사용 금지…), 원격 사용 중 현황, 채팅</summary>
public static class PcStatusEndpoints
{
    public static void MapPcStatusApi(this WebApplication app)
    {
        app.MapGet("/api/pc-status", (PcStatusStore store) => store.Load());

        app.MapPut("/api/agents/{agentId}/status", async (
            string agentId, SetPcStatusRequest request, HttpRequest http, PcStatusStore store,
            IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            PcStatusesView saved;
            try
            {
                saved = store.Set(agentId, request.Status, request.Note, UserId(http));
            }
            catch (ArgumentException ex)
            {
                return Results.BadRequest(ex.Message);
            }
            await dashboard.Clients.All.PcStatusesChanged(saved);
            return Results.Ok(saved);
        });

        app.MapGet("/api/remote-usage", (RemoteUsageRegistry usage) => usage.Snapshot());

        app.MapGet("/api/chat", (int? take, ChatStore chat) => chat.Recent(Math.Clamp(take ?? 100, 1, 500)));
    }

    private static string? UserId(HttpRequest request)
    {
        var value = request.Headers["X-User-Id"].ToString();
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }
}
