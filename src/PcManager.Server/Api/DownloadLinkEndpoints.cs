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
        app.MapGet("/dl/{token}", async (
            string token, HttpContext context, DownloadLinkStore store, AgentRegistry registry,
            IHubContext<AgentHub> agentHub, SharedFolderStore shares, LocalShareFiles localShare) =>
        {
            if (!store.TryGet(token, out var link))
            {
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                return;
            }
            await StreamAsAttachmentAsync(context, link.AgentId, link.Path, link.Name, registry, agentHub, shares, localShare);
        });

        // 대시보드에서 바로 다운로드(브라우저 다운로드 폴더로) — 파일 우클릭/더블클릭
        app.MapGet("/api/agents/{agentId}/download", async (
            string agentId, string? path, HttpContext context, AgentRegistry registry,
            IHubContext<AgentHub> agentHub, SharedFolderStore shares, LocalShareFiles localShare) =>
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                context.Response.StatusCode = StatusCodes.Status400BadRequest;
                return;
            }
            var name = Path.GetFileName(path.TrimEnd('\\', '/'));
            await StreamAsAttachmentAsync(context, agentId, path, string.IsNullOrEmpty(name) ? "download" : name, registry, agentHub, shares, localShare);
        });
    }

    /// <summary>파일을 첨부(attachment)로 내보낸다. 공유=로컬 파일, 에이전트=조각 중계.</summary>
    private static async Task StreamAsAttachmentAsync(
        HttpContext context, string agentId, string path, string name,
        AgentRegistry registry, IHubContext<AgentHub> agentHub, SharedFolderStore shares, LocalShareFiles localShare)
    {
        var response = context.Response;
        var contentType = ContentTypes.TryGetContentType(name, out var t) ? t : "application/octet-stream";

        // 공유 폴더: 서버 로컬 파일을 그대로 내보낸다
        if (shares.TryGet(agentId, out var share))
        {
            try
            {
                var full = localShare.ResolveWithin(share, path);
                if (!File.Exists(full))
                {
                    response.StatusCode = StatusCodes.Status404NotFound;
                    return;
                }
                await Results.File(full, contentType, name, enableRangeProcessing: true).ExecuteAsync(context);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            {
                response.StatusCode = StatusCodes.Status502BadGateway;
                await response.WriteAsync(ex.Message, context.RequestAborted);
            }
            return;
        }

        // 에이전트: 온라인이면 조각으로 받아 중계 (첨부 다운로드)
        if (!registry.TryGetConnection(agentId, out var connectionId))
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
            size = await proxy.InvokeAsync<long>(AgentClientMethods.GetFileSize, path, ct);
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
        response.Headers.ContentDisposition = $"attachment; filename*=UTF-8''{Uri.EscapeDataString(name)}";

        var offset = 0L;
        while (offset < size && !ct.IsCancellationRequested)
        {
            var want = (int)Math.Min(ChunkSize, size - offset);
            byte[] data;
            try
            {
                data = await proxy.InvokeAsync<byte[]>(AgentClientMethods.ReadFileChunk, path, offset, want, ct);
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
