using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core.Features;
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
/// 브라우저의 Range 요청 구간을 에이전트가 HTTP로 올려 보내면(StreamFileRange) 받는 대로 브라우저로 넘긴다 — 사내망 속도.
/// 옛 에이전트이거나 HTTP로 붙지 못하면 SignalR 조각 중계로: 조각을 여러 개 미리 요청해 두어(파이프라인) 조각마다 왕복을 기다리지 않는다
/// </summary>
public static class MediaEndpoints
{
    // 조각 크기 × 동시에 요청해 두는 개수 = 왕복 한 번에 오갈 수 있는 양 (256KB × 4 = 1MB, 한 개씩일 때의 4배).
    // 에이전트의 SignalR 연결 하나로 오가므로 너무 많이 쌓으면 같은 연결의 다른 요청·하트비트가 밀려 연결이 끊긴다
    // (512KB × 8 시험에서 끊김 확인) → 1MB 정도로 제한
    private const int ChunkSize = 256 * 1024;
    private const int Pipeline = 4;
    // 에이전트가 HTTP 스트림을 시작하기까지 기다리는 시간 (넘으면 조각 중계로)
    private static readonly TimeSpan StartTimeout = TimeSpan.FromSeconds(10);

    // 브라우저에서 <video>로 재생 가능한 형식. 그 외(mkv, avi 등)는 재생이 안 될 수 있다.
    private static readonly FileExtensionContentTypeProvider ContentTypes = new();

    public static void MapMediaApi(this WebApplication app)
    {
        // 일부 플레이어가 크기 확인용 HEAD를 먼저 보낸다
        app.MapMethods("/api/agents/{agentId}/media", ["GET", "HEAD"], HandleAsync);

        // 에이전트 전용 (Program.cs 미들웨어가 /api/agent 경로의 토큰을 검사): 영상 구간 본문을 브라우저로 넘긴다
        app.MapPost(AgentTransferPaths.MediaStream("{streamId}"), async (string streamId, HttpContext context, MediaStreamBroker broker) =>
        {
            // 브라우저가 일시정지해 읽지 않는 동안 본문이 멈춰 있어도 끊지 않는다 (크기 제한도 없음)
            if (context.Features.Get<IHttpMinRequestBodyDataRateFeature>() is { } rate)
                rate.MinDataRate = null;
            if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } max)
                max.MaxRequestBodySize = null;
            var finished = await broker.AcceptAsync(streamId, context.Request.Body, context.RequestAborted);
            if (finished is null)
                context.Response.StatusCode = StatusCodes.Status404NotFound;
            else if (finished == false)
                context.Abort(); // 브라우저가 끊음 → 에이전트도 보내기를 멈추게
        });
    }

    private static async Task HandleAsync(
        string agentId, string? path, HttpContext context, AgentRegistry registry, IHubContext<AgentHub> agentHub,
        SharedFolderStore shares, LocalShareFiles localShare, MediaStreamBroker broker)
    {
        var response = context.Response;
        if (string.IsNullOrWhiteSpace(path))
        {
            response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        // 공유 폴더면 서버 로컬 파일을 Range 지원으로 바로 내보낸다
        if (shares.TryGet(agentId, out var share))
        {
            try
            {
                var stream = localShare.OpenRead(share, path);
                if (stream is null)
                {
                    response.StatusCode = StatusCodes.Status404NotFound;
                    return;
                }
                var shareType = ContentTypes.TryGetContentType(path, out var mt) ? mt : "application/octet-stream";
                await Results.File(stream, shareType, enableRangeProcessing: true).ExecuteAsync(context);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            {
                response.StatusCode = StatusCodes.Status502BadGateway;
                await response.WriteAsync(ex.Message, context.RequestAborted);
            }
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

        // 빠른 길: 에이전트가 HTTP로 흘려보내는 구간을 그대로 넘긴다
        if (await TryStreamAsync(agentId, path, start, end - start + 1, proxy, broker, response, ct))
            return;

        // 조각을 Pipeline개까지 미리 요청해 두고, 순서대로 받아 브라우저로 보낸다
        var inflight = new Queue<Task<byte[]>>();
        var next = start;
        void RequestMore()
        {
            while (inflight.Count < Pipeline && next <= end)
            {
                var want = (int)Math.Min(ChunkSize, end - next + 1);
                inflight.Enqueue(proxy.InvokeAsync<byte[]>(AgentClientMethods.ReadFileChunk, path, next, want, ct));
                next += want;
            }
        }

        RequestMore();
        while (inflight.Count > 0 && !ct.IsCancellationRequested)
        {
            byte[] data;
            try
            {
                data = await inflight.Dequeue();
            }
            catch (Exception)
            {
                break; // 브라우저가 연결을 끊음(seek 등)·에이전트 오류
            }

            // EOF(녹화 중 파일 크기 변화 등)면 그 뒤 조각은 어긋나므로 멈춘다
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
            RequestMore();
        }
    }

    /// <summary>
    /// 에이전트에게 구간을 HTTP로 올려 달라고 하고, 받는 대로 브라우저로 보낸다.
    /// false면 아직 아무것도 보내지 않았으니 조각 중계로 (옛 에이전트·HTTP로 못 붙음)
    /// </summary>
    private static async Task<bool> TryStreamAsync(
        string agentId, string path, long start, long length, ISingleClientProxy proxy, MediaStreamBroker broker, HttpResponse response, CancellationToken ct)
    {
        if (broker.IsUnsupported(agentId))
            return false;
        var (id, pending) = broker.Create();
        try
        {
            using (var wait = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                wait.CancelAfter(StartTimeout);
                try
                {
                    if (!await proxy.InvokeAsync<bool>(AgentClientMethods.StreamFileRange, id, path, start, length, wait.Token))
                        return false;
                }
                catch (OperationCanceledException)
                {
                    return ct.IsCancellationRequested; // 브라우저가 끊었으면 끝, 에이전트가 느리면 조각 중계로
                }
                catch (Exception)
                {
                    broker.MarkUnsupported(agentId); // StreamFileRange가 없는 옛 에이전트
                    return false;
                }
            }

            Stream body;
            try
            {
                body = await pending.Body.Task.WaitAsync(StartTimeout, ct);
            }
            catch (TimeoutException)
            {
                return false; // 에이전트가 서버로 HTTP 연결을 못 함
            }
            catch (OperationCanceledException)
            {
                return true;
            }

            var complete = false;
            try
            {
                await body.CopyToAsync(response.Body, ChunkSize, ct);
                complete = true;
            }
            catch (Exception ex) when (ex is OperationCanceledException or IOException or Microsoft.AspNetCore.Connections.ConnectionResetException)
            {
                // 브라우저가 다른 위치로 넘어가 끊음
            }
            finally
            {
                pending.Done.TrySetResult(complete);
            }
            return true;
        }
        finally
        {
            broker.Forget(id);
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
