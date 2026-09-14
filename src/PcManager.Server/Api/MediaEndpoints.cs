using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.Primitives;
using Microsoft.Net.Http.Headers;
using PcManager.Server.Hubs;
using PcManager.Server.Services;
using PcManager.Shared;

namespace PcManager.Server.Api;

/// <summary>
/// 원격 PC의 미디어 파일을 서버로 복사하지 않고 브라우저로 스트리밍한다.
/// 브라우저의 Range 요청을 받아, 해당 구간만 에이전트에서 조각으로 받아 중계한다.
/// </summary>
public static class MediaEndpoints
{
    private const int ChunkSize = 256 * 1024;

    // 브라우저에서 <video>로 재생 가능한 형식. 그 외(mkv, avi 등)는 재생이 안 될 수 있다.
    private static readonly FileExtensionContentTypeProvider ContentTypes = new();

    public static void MapMediaApi(this WebApplication app)
    {
        // 일부 플레이어가 크기 확인용 HEAD를 먼저 보낸다
        app.MapMethods("/api/agents/{agentId}/media", ["GET", "HEAD"], HandleAsync);
    }

    private static async Task HandleAsync(
        string agentId, string? path, HttpContext context, AgentRegistry registry, IHubContext<AgentHub> agentHub)
    {
        var response = context.Response;
        if (string.IsNullOrWhiteSpace(path))
        {
            response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }
        if (!registry.TryGetConnection(agentId, out var connectionId))
        {
            response.StatusCode = StatusCodes.Status409Conflict;
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
            await response.WriteAsync($"에이전트에서 파일을 열 수 없습니다: {ex.Message}", ct);
            return;
        }
        if (size < 0)
        {
            response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        var (start, end, satisfiable) = ResolveRange(context.Request.Headers.Range, size);
        if (!satisfiable)
        {
            response.StatusCode = StatusCodes.Status416RangeNotSatisfiable;
            response.Headers.ContentRange = $"bytes */{size}";
            return;
        }

        response.Headers.AcceptRanges = "bytes";
        response.ContentType = ContentTypes.TryGetContentType(path, out var type) ? type : "application/octet-stream";
        response.ContentLength = end - start + 1;

        var isRangeRequest = !StringValues.IsNullOrEmpty(context.Request.Headers.Range);
        if (isRangeRequest)
        {
            response.StatusCode = StatusCodes.Status206PartialContent;
            response.Headers.ContentRange = $"bytes {start}-{end}/{size}";
        }

        // HEAD 요청이나 빈 파일은 본문 없이 헤더만
        if (HttpMethods.IsHead(context.Request.Method) || size == 0)
            return;

        var offset = start;
        while (offset <= end && !ct.IsCancellationRequested)
        {
            var want = (int)Math.Min(ChunkSize, end - offset + 1);
            byte[] data;
            try
            {
                data = await proxy.InvokeAsync<byte[]>(AgentClientMethods.ReadFileChunk, path, offset, want, ct);
            }
            catch (OperationCanceledException)
            {
                break; // 브라우저가 연결을 끊음 (seek 등)
            }
            catch (Exception)
            {
                break; // 스트림 중 오류 → 연결 종료
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

    /// <summary>Range 헤더를 [start, end]로 해석한다. 없으면 파일 전체.</summary>
    private static (long Start, long End, bool Satisfiable) ResolveRange(StringValues rangeHeader, long size)
    {
        if (StringValues.IsNullOrEmpty(rangeHeader) || size == 0)
            return (0, Math.Max(0, size - 1), true);

        // 단일 구간만 지원한다 (동영상 재생에는 충분)
        if (!RangeHeaderValue.TryParse(rangeHeader.ToString(), out var parsed) || parsed.Ranges.Count != 1)
            return (0, size - 1, true);

        var range = parsed.Ranges.First();
        long start, end;
        if (range.From is { } from)
        {
            start = from;
            end = range.To ?? size - 1;
        }
        else if (range.To is { } suffix)
        {
            // 마지막 suffix 바이트
            start = Math.Max(0, size - suffix);
            end = size - 1;
        }
        else
        {
            return (0, size - 1, true);
        }

        end = Math.Min(end, size - 1);
        if (start > end || start >= size)
            return (0, 0, false);
        return (start, end, true);
    }
}
