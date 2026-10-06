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
        // '원격 사용 중' 표시가 남았을 때 지우기 (연결은 건드리지 않는다)
        app.MapDelete("/api/remote-usage/{agentId}", async (string agentId, RemoteUsageRegistry usage, IHubContext<DashboardHub, IDashboardClient> dashboard) =>
        {
            usage.ForceRelease(agentId);
            await dashboard.Clients.All.RemoteUsageChanged(usage.Snapshot());
            return Results.NoContent();
        });

    }

    private static string? UserId(HttpRequest request)
    {
        var value = request.Headers["X-User-Id"].ToString();
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }
}
