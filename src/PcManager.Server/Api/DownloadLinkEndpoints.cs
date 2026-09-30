using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.StaticFiles;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Server.Services;
using PcManager.Shared;

namespace PcManager.Server.Api;

/// <summary>공개 다운로드 링크: 토큰만 있으면 누구나 파일을 받을 수 있다.</summary>
public static class DownloadLinkEndpoints
{
    private const int ChunkSize = 256 * 1024;
    private static readonly FileExtensionContentTypeProvider ContentTypes = new();

    public static void MapDownloadLinkApi(this WebApplication app)
    {
        // 링크 생성 (파일 우클릭 → 다운로드 링크)
        app.MapPost("/api/agents/{agentId}/download-links", (string agentId, CreateDownloadLinkRequest request, DownloadLinkStore store) =>
        {
            if (string.IsNullOrWhiteSpace(request.Path))
                return Results.BadRequest("파일 경로가 필요합니다.");
            var link = store.Create(agentId, request.Path);
            return Results.Ok(new DownloadLinkView(link.Token, $"/dl/{link.Token}", link.Name));
        });

        // 공개 다운로드 (인증 없음)
        app.MapGet("/dl/{token}", HandleDownloadAsync);
    }

    private static async Task HandleDownloadAsync(
        string token, HttpContext context, DownloadLinkStore store, AgentRegistry registry,
        IHubContext<AgentHub> agentHub, SharedFolderStore shares, LocalShareFiles localShare)
    {
        var response = context.Response;
        if (!store.TryGet(token, out var link))
        {
            response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        var contentType = ContentTypes.TryGetContentType(link.Name, out var t) ? t : "application/octet-stream";

        // 공유 폴더: 서버 로컬 파일을 그대로 내보낸다
        if (shares.TryGet(link.AgentId, out var share))
        {
            try
            {
                var full = localShare.ResolveWithin(share, link.Path);
                if (!File.Exists(full))
                {
                    response.StatusCode = StatusCodes.Status404NotFound;
                    return;
                }
                await Results.File(full, contentType, link.Name, enableRangeProcessing: true).ExecuteAsync(context);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            {
                response.StatusCode = StatusCodes.Status502BadGateway;
                await response.WriteAsync(ex.Message, context.RequestAborted);
            }
            return;
        }

        // 에이전트: 온라인이면 조각으로 받아 중계 (첨부 다운로드)
        if (!registry.TryGetConnection(link.AgentId, out var connectionId))
        {
            response.StatusCode = StatusCodes.Status409Conflict;
            await response.WriteAsync("이 파일을 가진 PC가 오프라인입니다.", context.RequestAborted);
            return;
        }

        var ct = context.RequestAborted;
        var proxy = agentHub.Clients.Client(connectionId);
        long size;
        try
        {
            size = await proxy.InvokeAsync<long>(AgentClientMethods.GetFileSize, link.Path, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            response.StatusCode = StatusCodes.Status502BadGateway;
            await response.WriteAsync($"파일을 열 수 없습니다: {ex.Message}", ct);
            return;
        }
        if (size < 0)
        {
            response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        response.ContentType = contentType;
        response.ContentLength = size;
        response.Headers.ContentDisposition = $"attachment; filename*=UTF-8''{Uri.EscapeDataString(link.Name)}";

        var offset = 0L;
        while (offset < size && !ct.IsCancellationRequested)
        {
            var want = (int)Math.Min(ChunkSize, size - offset);
            byte[] data;
            try
            {
                data = await proxy.InvokeAsync<byte[]>(AgentClientMethods.ReadFileChunk, link.Path, offset, want, ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception)
            {
                break;
            }
            if (data.Length == 0)
                break;
            try
            {
                await response.Body.WriteAsync(data, ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            offset += data.Length;
        }
    }
}
