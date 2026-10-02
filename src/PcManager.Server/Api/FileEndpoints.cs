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

    /// <summary>압축 파일 이름을 정한다: 한 개면 그 이름, 여러 개면 "첫이름 외 N개".</summary>
    private static string DefaultArchiveName(IReadOnlyList<string> paths)
    {
        var first = Path.GetFileName(paths[0].TrimEnd('\\', '/'));
        return paths.Count == 1 ? first + ".zip" : $"{first} 외 {paths.Count - 1}개.zip";
    }

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
            string agentId, string? path, AgentRegistry registry, IHubContext<AgentHub> agentHub,
            SharedFolderStore shares, LocalShareFiles localShare, CancellationToken ct) =>
        {
            // 공유 폴더면 서버가 직접 처리
            if (shares.TryGet(agentId, out var share))
                return Results.Ok(localShare.ListDirectory(share, path));

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

        // 같은 PC 안의 파일 조작 (복사/이동/삭제/폴더 생성/이름 변경)
        api.MapPost("/agents/{agentId}/files/op", async (
            string agentId, FileOpRequest request, AgentRegistry registry, IHubContext<AgentHub> agentHub,
            SharedFolderStore shares, LocalShareFiles localShare, CancellationToken ct) =>
        {
            if (shares.TryGet(agentId, out var share))
            {
                var localResult = localShare.PerformFileOp(share, request);
                return localResult.Success ? Results.Ok(localResult) : Results.BadRequest(localResult.Error ?? "작업에 실패했습니다.");
            }

            if (!registry.TryGetConnection(agentId, out var connectionId))
                return Results.Conflict("에이전트가 오프라인입니다.");

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromMinutes(5));
            try
            {
                var result = await agentHub.Clients.Client(connectionId)
                    .InvokeAsync<FileOpResult>(AgentClientMethods.FileOp, request, timeout.Token);
                return result.Success ? Results.Ok(result) : Results.BadRequest(result.Error ?? "작업에 실패했습니다.");
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return Results.Problem("작업 시간이 초과되었습니다.", statusCode: StatusCodes.Status504GatewayTimeout);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // 옛 에이전트에는 파일 조작 핸들러가 없어 인자 파싱/메서드 오류가 난다
                var message = ex.Message.Contains("parse argument", StringComparison.OrdinalIgnoreCase)
                    || ex.Message.Contains("does not exist", StringComparison.OrdinalIgnoreCase)
                    ? "이 PC의 에이전트가 파일 조작을 지원하지 않는 옛 버전입니다. 에이전트를 최신 버전으로 업데이트하세요."
                    : ex.Message;
                return Results.Problem(message, statusCode: StatusCodes.Status502BadGateway);
            }
        });

        api.MapPost("/agents/{agentId}/files/fetch", async (
            string agentId, FetchFileRequest request, TransferService transfers,
            SharedFolderStore shares, LocalShareFiles localShare, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(request.Path))
                return Results.BadRequest("가져올 파일 경로를 입력하세요.");
            if (shares.TryGet(agentId, out var share))
            {
                var stream = localShare.OpenRead(share, request.Path);
                if (stream is null)
                    return Results.BadRequest("파일이 없거나 접근할 수 없습니다.");
                var size = stream.Length;
                await using (stream)
                    return Results.Ok(await transfers.FetchLocalAsync(agentId, request.Path, stream, size, ct));
            }
            return Results.Ok(await transfers.FetchAsync(agentId, request.Path));
        });

        // PC(또는 공유 폴더) 안에서 선택 항목을 ZIP으로 압축
        api.MapPost("/agents/{agentId}/files/compress", async (
            string agentId, CompressFilesRequest request, TransferService transfers,
            SharedFolderStore shares, LocalShareFiles localShare) =>
        {
            if (request.Paths is null or { Count: 0 } || string.IsNullOrWhiteSpace(request.DestinationFolder))
                return Results.BadRequest("압축할 항목과 대상 폴더가 필요합니다.");
            var name = string.IsNullOrWhiteSpace(request.ArchiveName) ? DefaultArchiveName(request.Paths) : request.ArchiveName!;

            if (shares.TryGet(agentId, out var share))
            {
                try
                {
                    var size = localShare.Compress(share, request.Paths, request.DestinationFolder!, name);
                    var target = request.DestinationFolder!.TrimEnd('\\', '/') + "\\" + name;
                    return Results.Ok(await transfers.RecordLocalDoneAsync(agentId, TransferKind.Compress, target, size));
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or FileNotFoundException)
                {
                    return Results.BadRequest("압축 실패: " + ex.Message);
                }
            }
            return Results.Ok(await transfers.CompressAsync(agentId, request.Paths, request.DestinationFolder!, name, Math.Max(0, request.SplitBytes)));
        });

        // PC 간 붙여넣기 (원본 → 서버 중계 → 대상, 디스크 미경유). 단일 파일만.
        api.MapPost("/files/cross-copy", async (CrossCopyRequest request, TransferService transfers, SharedFolderStore shares, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(request.SourcePath) || string.IsNullOrWhiteSpace(request.DestFolder))
                return Results.BadRequest("원본과 대상 폴더가 필요합니다.");
            var result = await transfers.CrossCopyAsync(
                request.SourceAgentId, request.SourcePath, request.DestAgentId, request.DestFolder, request.Move, ct);
            return result.Success ? Results.Ok(result) : Results.BadRequest(result.Error ?? "실패");
        });

        // 브라우저는 파일 내용을 요청 본문 그대로 보낸다 (path = PC에 저장할 전체 경로)
        api.MapPost("/agents/{agentId}/files/push", async (
            string agentId, string path, HttpRequest request, TransferService transfers,
            SharedFolderStore shares, LocalShareFiles localShare, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(path))
                return Results.BadRequest("저장할 경로를 입력하세요.");
            if (shares.TryGet(agentId, out var share))
            {
                try
                {
                    var saved = await localShare.SaveUploadAsync(share, path, request.Body, ct);
                    var size = new FileInfo(saved).Length;
                    return Results.Ok(await transfers.RecordLocalDoneAsync(agentId, TransferKind.Push, saved, size));
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
                {
                    return Results.BadRequest("올리기 실패: " + ex.Message);
                }
            }
            return Results.Ok(await transfers.PushAsync(agentId, path, request.Body, ct));
        }).WithMetadata(new DisableRequestSizeLimitAttribute());

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
