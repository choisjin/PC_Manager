using PcManager.Server.Contracts;
using PcManager.Server.Services;

namespace PcManager.Server.Api;

/// <summary>영상 분석 기준값 (프로젝트별): 결과 확인의 영상 분석과 설정 화면이 읽고 쓴다</summary>
public static class AnalysisDefaultsEndpoints
{
    public static void MapAnalysisDefaultsApi(this WebApplication app)
    {
        var api = app.MapGroup("/api/analysis-defaults");

        api.MapGet("/{projectId}", (string projectId, AnalysisDefaultsStore store) => store.Get(projectId));

        api.MapPut("/{projectId}", (string projectId, SaveAnalysisDefaults body, HttpRequest http, AnalysisDefaultsStore store, OrgStore org) =>
        {
            if (org.Load().Projects.All(p => p.Id != projectId))
                return Results.NotFound("프로젝트가 없습니다.");
            var userId = http.Headers["X-User-Id"].ToString() is { Length: > 0 } id ? id : null;
            return Results.Ok(store.Set(projectId, body.Values ?? new Dictionary<string, double>(), userId));
        });
    }
}
