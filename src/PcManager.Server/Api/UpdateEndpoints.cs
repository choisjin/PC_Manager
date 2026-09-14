using PcManager.Server.Services;

namespace PcManager.Server.Api;

public static class UpdateEndpoints
{
    public static void MapUpdateApi(this WebApplication app)
    {
        var api = app.MapGroup("/api/update");

        api.MapGet("/", (UpdateService updates) => updates.GetStatus());

        api.MapPost("/check", async (UpdateService updates, CancellationToken ct) => await updates.CheckAsync(ct));

        // 서버 자가 업데이트 시작 (다운로드 → 설치 → 재시작). 즉시 202를 주고 백그라운드로 진행한다.
        api.MapPost("/server", (UpdateService updates) =>
            updates.TryStartServerUpdate(out var error)
                ? Results.Accepted()
                : Results.Conflict(error));

        // 에이전트 업데이트 명령 전송. body가 없거나 비면 구버전 전체.
        api.MapPost("/agents", async (AgentUpdateRequest? request, UpdateService updates) =>
            Results.Ok(await updates.UpdateAgentsAsync(request?.AgentIds)));
    }

    public record AgentUpdateRequest(IReadOnlyList<string>? AgentIds);
}
