using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Server.Services;
using PcManager.Shared;

namespace PcManager.Server.Api;

/// <summary>
/// 파일 탐색기의 텍스트 보기/편집과 압축 파일 다루기(압축 풀기, 암호).
/// 텍스트는 서버가 인코딩을 판별해 브라우저에 주고, 저장할 때 원래 인코딩·줄바꿈으로 되돌려 그 PC에 쓴다.
/// </summary>
public static class TextEndpoints
{
    private const int ChunkSize = 256 * 1024;

    public static void MapTextApi(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/agents/{agentId}/text", async (
            string agentId, string? path, AgentRegistry registry, IHubContext<AgentHub> agentHub,
            SharedFolderStore shares, LocalShareFiles localShare, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(path))
                return Results.BadRequest("파일 경로가 필요합니다.");
            var read = await ReadAllAsync(agentId, path, registry, agentHub, shares, localShare, ct);
            if (read.Error is not null)
                return Results.Problem(read.Error, statusCode: read.Status);
            var view = TextCodec.Decode(read.Bytes!);
            return view is null
                ? Results.Problem("텍스트 파일이 아닙니다 (바이너리). 가져오기로 내려받아 여세요.", statusCode: StatusCodes.Status415UnsupportedMediaType)
                : Results.Ok(view);
        });

        api.MapPut("/agents/{agentId}/text", async (
            string agentId, SaveTextRequest request, AgentRegistry registry, IHubContext<AgentHub> agentHub,
            SharedFolderStore shares, LocalShareFiles localShare, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(request.Path))
                return Results.BadRequest("파일 경로가 필요합니다.");
            var bytes = TextCodec.Encode(request.Content ?? "", request.Encoding, request.Newline);

            // 편집하는 동안 다른 곳에서 바뀌었는지 확인
            if (request.BaseHash is not null)
            {
                var current = await ReadAllAsync(agentId, request.Path, registry, agentHub, shares, localShare, ct);
                if (current.Bytes is not null && TextCodec.Hash(current.Bytes) != request.BaseHash)
                    return Results.Ok(new SaveTextResult(false, true, "편집하는 동안 다른 곳에서 파일이 바뀌었습니다.", null));
            }

            string? error;
            if (shares.TryGet(agentId, out var share))
                error = localShare.ReplaceFile(share, request.Path, bytes, request.Backup);
            else
                error = await WriteToAgentAsync(agentId, request.Path, bytes, request.Backup, registry, agentHub, ct);
            return Results.Ok(error is null
                ? new SaveTextResult(true, false, null, TextCodec.Hash(bytes))
                : new SaveTextResult(false, false, error, null));
        });

        // 내 PC 프로그램으로 열기: editorAgentId = 대시보드를 연 PC의 에이전트
        api.MapPost("/agents/{agentId}/open-local", async (string agentId, OpenLocalRequest request, TransferService transfers, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(request.Path) || string.IsNullOrWhiteSpace(request.EditorAgentId))
                return Results.BadRequest("파일 경로와 내 PC가 필요합니다.");
            var error = await transfers.OpenLocalAsync(agentId, request.Path!, request.EditorAgentId!,
                string.IsNullOrWhiteSpace(request.Label) ? agentId : request.Label!, request.ReadOnly, request.Backup, ct);
            return error is null ? Results.NoContent() : Results.BadRequest(error);
        });

        // 편집 PC 에이전트 → 저장한 내용을 원래 PC로 (토큰 검사는 /api/agent 미들웨어)
        app.MapPost(AgentTransferPaths.EditSave, async (string source, string path, string? baseHash, int? backup, HttpRequest http, TransferService transfers, CancellationToken ct) =>
        {
            using var memory = new MemoryStream();
            await http.Body.CopyToAsync(memory, ct);
            return Results.Ok(await transfers.SaveEditAsync(source, path, string.IsNullOrEmpty(baseHash) ? null : baseHash, memory.ToArray(), backup == 1, ct));
        }).WithMetadata(new Microsoft.AspNetCore.Mvc.DisableRequestSizeLimitAttribute());

        // 편집 중인 내용을 원래 인코딩으로 내려받기 (내 PC에 저장)
        api.MapPost("/text/encode", (EncodeTextRequest request) =>
            Results.File(TextCodec.Encode(request.Content ?? "", request.Encoding, request.Newline), "application/octet-stream"));

        // 압축 풀기 (같은 PC 안에서)
        api.MapPost("/agents/{agentId}/files/extract", async (
            string agentId, ExtractFilesRequest request, TransferService transfers,
            SharedFolderStore shares, LocalShareFiles localShare) =>
        {
            if (string.IsNullOrWhiteSpace(request.ArchivePath) || string.IsNullOrWhiteSpace(request.DestinationFolder))
                return Results.BadRequest("압축 파일과 풀 폴더가 필요합니다.");
            var entries = request.EntryPaths ?? [];
            if (shares.TryGet(agentId, out var share))
            {
                try
                {
                    var (_, bytes) = localShare.Extract(share, request.ArchivePath!, entries, request.DestinationFolder!);
                    return Results.Ok(await transfers.RecordLocalDoneAsync(agentId, TransferKind.Extract, request.DestinationFolder!, bytes));
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or ArchiveContentException)
                {
                    return Results.BadRequest("압축 풀기 실패: " + ex.Message);
                }
            }
            return Results.Ok(await transfers.ExtractAsync(agentId, request.ArchivePath!, entries, request.DestinationFolder!));
        });

        // 암호 걸린 압축 파일의 암호 (그 PC 프로세스 메모리에만 둔다)
        api.MapPost("/agents/{agentId}/archive-password", async (
            string agentId, ArchivePasswordRequest request, AgentRegistry registry, IHubContext<AgentHub> agentHub,
            SharedFolderStore shares, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(request.ArchivePath))
                return Results.BadRequest("압축 파일 경로가 필요합니다.");
            if (shares.TryGet(agentId, out _))
            {
                ArchiveBrowser.SetPassword(request.ArchivePath!, request.Password ?? "");
                return Results.Ok();
            }
            if (!registry.TryGetConnection(agentId, out var connectionId))
                return Results.Conflict("에이전트가 오프라인입니다.");
            try
            {
                await agentHub.Clients.Client(connectionId)
                    .InvokeAsync<bool>(AgentClientMethods.SetArchivePassword, request.ArchivePath!, request.Password ?? "", ct);
                return Results.Ok();
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return Results.Problem(OldAgentMessage(ex), statusCode: StatusCodes.Status502BadGateway);
            }
        });
    }

    private record ReadResult(byte[]? Bytes, string? Error, int Status);

    /// <summary>파일 전체를 읽는다 (편집 가능한 크기까지만).</summary>
    private static async Task<ReadResult> ReadAllAsync(
        string agentId, string path, AgentRegistry registry, IHubContext<AgentHub> agentHub,
        SharedFolderStore shares, LocalShareFiles localShare, CancellationToken ct)
    {
        if (shares.TryGet(agentId, out var share))
        {
            try
            {
                await using var stream = localShare.OpenRead(share, path);
                if (stream is null)
                    return new ReadResult(null, "파일이 없거나 열 수 없습니다.", StatusCodes.Status404NotFound);
                if (stream.Length > TextCodec.MaxBytes)
                    return TooLarge(stream.Length);
                using var memory = new MemoryStream();
                await stream.CopyToAsync(memory, ct);
                return new ReadResult(memory.ToArray(), null, 200);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
            {
                return new ReadResult(null, ex.Message, StatusCodes.Status502BadGateway);
            }
        }

        if (!registry.TryGetConnection(agentId, out var connectionId))
            return new ReadResult(null, "에이전트가 오프라인입니다.", StatusCodes.Status409Conflict);
        var proxy = agentHub.Clients.Client(connectionId);
        try
        {
            var size = await proxy.InvokeAsync<long>(AgentClientMethods.GetFileSize, path, ct);
            if (size < 0)
                return new ReadResult(null, "파일이 없거나 열 수 없습니다.", StatusCodes.Status404NotFound);
            if (size > TextCodec.MaxBytes)
                return TooLarge(size);
            var buffer = new byte[size];
            var offset = 0;
            while (offset < size)
            {
                var data = await proxy.InvokeAsync<byte[]>(AgentClientMethods.ReadFileChunk, path, (long)offset, (int)Math.Min(1024 * 1024, size - offset), ct);
                if (data.Length == 0)
                    break;
                data.CopyTo(buffer, offset);
                offset += data.Length;
            }
            return new ReadResult(offset == size ? buffer : buffer[..offset], null, 200);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new ReadResult(null, "파일을 읽지 못했습니다: " + ex.Message, StatusCodes.Status502BadGateway);
        }
    }

    private static ReadResult TooLarge(long size) =>
        new(null, $"파일이 너무 커서({size / 1024 / 1024}MB) 바로 열 수 없습니다. 최대 {TextCodec.MaxBytes / 1024 / 1024}MB. 가져오기로 내려받아 여세요.",
            StatusCodes.Status413PayloadTooLarge);

    /// <summary>에이전트에 임시 파일로 보낸 뒤 원래 파일과 바꾼다. 실패하면 오류 문구.</summary>
    internal static async Task<string?> WriteToAgentAsync(
        string agentId, string path, byte[] bytes, bool backup, AgentRegistry registry, IHubContext<AgentHub> agentHub, CancellationToken ct)
    {
        if (!registry.TryGetConnection(agentId, out var connectionId))
            return "에이전트가 오프라인입니다.";
        var proxy = agentHub.Clients.Client(connectionId);
        var folder = Path.GetDirectoryName(path);
        if (string.IsNullOrEmpty(folder))
            return "저장할 경로가 올바르지 않습니다.";
        string? writeId = null;
        try
        {
            writeId = await proxy.InvokeAsync<string>(AgentClientMethods.BeginWrite, folder, Path.GetFileName(path) + ".pcm-edit", ct);
            for (var offset = 0; offset < bytes.Length; offset += ChunkSize)
                await proxy.InvokeAsync<int>(AgentClientMethods.WriteChunk, writeId, bytes[offset..Math.Min(bytes.Length, offset + ChunkSize)], ct);
            return await proxy.InvokeAsync<string?>(AgentClientMethods.CommitReplace, new CommitReplaceRequest(writeId, path, backup), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            if (writeId is not null)
            {
                try { await proxy.InvokeAsync<bool>(AgentClientMethods.AbortWrite, writeId, CancellationToken.None); }
                catch { /* 정리 실패는 무시 */ }
            }
            return OldAgentMessage(ex);
        }
    }

    // 옛 에이전트에는 새 핸들러가 없어 메서드 오류가 난다
    internal static string OldAgentMessage(Exception ex) =>
        ex.Message.Contains("does not exist", StringComparison.OrdinalIgnoreCase)
        || ex.Message.Contains("parse argument", StringComparison.OrdinalIgnoreCase)
        || ex.Message.Contains("No client method", StringComparison.OrdinalIgnoreCase)
            ? "이 PC의 에이전트가 옛 버전입니다. 에이전트를 최신 버전으로 업데이트하세요."
            : ex.Message;
}
