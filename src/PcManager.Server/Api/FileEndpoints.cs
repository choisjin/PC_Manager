using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.EntityFrameworkCore;
using PcManager.Server.Contracts;
using PcManager.Server.Data;
using PcManager.Server.Hubs;
using PcManager.Server.Services;
using PcManager.Shared;

namespace PcManager.Server.Api;

public static class FileEndpoints
{
    private static readonly TimeSpan ListTimeout = TimeSpan.FromSeconds(15);

    public static void MapFileApi(this WebApplication app)
    {
        // 에이전트 전용: Program.cs 미들웨어가 /api/agent 경로의 토큰을 검사한다
        var agentApi = app.MapGroup("/api/agent/transfers/{transferId}");

        agentApi.MapPost("/files", async (string transferId, string path, HttpRequest request, TransferService transfers, CancellationToken ct) =>
        {
            try
            {
                return Results.Ok(await transfers.SaveUploadedFileAsync(transferId, path, request.Body, ct));
            }
            catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
            {
                return Results.BadRequest(ex.Message);
            }
        }).WithMetadata(new DisableRequestSizeLimitAttribute());

        agentApi.MapGet("/content", async (string transferId, TransferService transfers) =>
        {
            if (!Guid.TryParseExact(transferId, "N", out _))
                return Results.NotFound();
            var path = await transfers.GetPushContentPathAsync(transferId);
            return path is null ? Results.NotFound() : Results.File(path, "application/octet-stream");
        });

        var api = app.MapGroup("/api");

        api.MapGet("/agents/{agentId}/files", async (
            string agentId, string? path, AgentRegistry registry, IHubContext<AgentHub> agentHub, CancellationToken ct) =>
        {
            if (!registry.TryGetConnection(agentId, out var connectionId))
                return Results.Conflict("에이전트가 오프라인입니다.");

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(ListTimeout);
            try
            {
                var listing = await agentHub.Clients.Client(connectionId)
                    .InvokeAsync<DirectoryListing>(AgentClientMethods.ListDirectory, path ?? "", timeout.Token);
                return Results.Ok(listing);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return Results.Problem("에이전트 응답 시간이 초과되었습니다.", statusCode: StatusCodes.Status504GatewayTimeout);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return Results.Problem(ex.Message, statusCode: StatusCodes.Status502BadGateway);
            }
        });

        api.MapPost("/agents/{agentId}/files/fetch", async (string agentId, FetchFileRequest request, TransferService transfers) =>
            string.IsNullOrWhiteSpace(request.Path)
                ? Results.BadRequest("가져올 파일 경로를 입력하세요.")
                : Results.Ok(await transfers.FetchAsync(agentId, request.Path)));

        // 브라우저는 파일 내용을 요청 본문 그대로 보낸다 (path = PC에 저장할 전체 경로)
        api.MapPost("/agents/{agentId}/files/push", async (
            string agentId, string path, HttpRequest request, TransferService transfers, CancellationToken ct) =>
            string.IsNullOrWhiteSpace(path)
                ? Results.BadRequest("저장할 경로를 입력하세요.")
                : Results.Ok(await transfers.PushAsync(agentId, path, request.Body, ct)))
            .WithMetadata(new DisableRequestSizeLimitAttribute());

        api.MapGet("/transfers", async (string? agentId, string? jobRunId, int? take, IDbContextFactory<AppDbContext> dbFactory) =>
        {
            await using var db = await dbFactory.CreateDbContextAsync();
            var query = db.Transfers.AsNoTracking();
            if (!string.IsNullOrEmpty(agentId))
                query = query.Where(t => t.AgentId == agentId);
            if (!string.IsNullOrEmpty(jobRunId))
                query = query.Where(t => t.JobRunId == jobRunId);

            var transfers = await query
                .OrderByDescending(t => t.CreatedAt)
                .Take(Math.Clamp(take ?? 100, 1, 500))
                .ToListAsync();
            return transfers.Select(t => t.ToView());
        });

        api.MapGet("/artifacts", async (string? transferId, string? jobRunId, string? agentId, IDbContextFactory<AppDbContext> dbFactory) =>
        {
            await using var db = await dbFactory.CreateDbContextAsync();
            var query = db.Artifacts.AsNoTracking();
            if (!string.IsNullOrEmpty(transferId))
                query = query.Where(a => a.TransferId == transferId);
            if (!string.IsNullOrEmpty(jobRunId))
                query = query.Where(a => a.JobRunId == jobRunId);
            if (!string.IsNullOrEmpty(agentId))
                query = query.Where(a => a.AgentId == agentId);

            var artifacts = await query.OrderBy(a => a.RelativePath).Take(2000).ToListAsync();
            return artifacts.Select(a => a.ToView());
        });

        // inline=true면 브라우저에서 바로 보기 (텍스트, 이미지 등)
        api.MapGet("/artifacts/{id}/download", async (string id, bool? inline, IDbContextFactory<AppDbContext> dbFactory, ArtifactStore store) =>
        {
            await using var db = await dbFactory.CreateDbContextAsync();
            var artifact = await db.Artifacts.AsNoTracking().FirstOrDefaultAsync(a => a.Id == id);
            if (artifact is null)
                return Results.NotFound();

            var path = store.GetArtifactPath(artifact.TransferId, artifact.RelativePath);
            if (!File.Exists(path))
                return Results.NotFound();

            if (!new FileExtensionContentTypeProvider().TryGetContentType(path, out var contentType))
                contentType = "application/octet-stream";

            return inline == true
                ? Results.File(path, contentType, enableRangeProcessing: true)
                : Results.File(path, contentType, Path.GetFileName(artifact.RelativePath), enableRangeProcessing: true);
        });
    }
}
