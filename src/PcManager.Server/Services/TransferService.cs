using System.Security.Cryptography;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using PcManager.Server.Contracts;
using PcManager.Server.Data;
using PcManager.Server.Hubs;
using PcManager.Shared;

namespace PcManager.Server.Services;

/// <summary>결과 수집, PC ↔ 서버 파일 전송을 관리한다.</summary>
public class TransferService(
    IDbContextFactory<AppDbContext> dbFactory,
    AgentRegistry registry,
    ArtifactStore store,
    CompletionNotifier notifier,
    IHubContext<AgentHub, IAgentClient> agentHub,
    IHubContext<AgentHub> agentHubRaw,
    IHubContext<DashboardHub, IDashboardClient> dashboard,
    IHttpContextAccessor httpContext,
    SharedFolderStore shares,
    LocalShareFiles localShare,
    ILogger<TransferService> logger)
{
    // PC 간 직접 전송 시 한 번에 옮기는 조각 크기 (서버 디스크를 거치지 않고 원본→대상으로 중계)
    private const int CrossCopyChunkSize = 256 * 1024;

    /// <summary>
    /// PC 간 파일 붙여넣기: 원본 PC에서 읽은 조각을 서버 디스크에 저장하지 않고 곧바로 대상 PC로 흘려보낸다.
    /// (에이전트는 서버로 아웃바운드 연결만 하므로 P2P 대신 서버가 조각을 중계한다.)
    /// 폴더면 하위까지 통째로 복사한다. 잘라내기면 완료 후 원본을 지운다.
    /// </summary>
    public async Task<FileOpResult> CrossCopyAsync(
        string sourceAgentId, string sourcePath, string destAgentId, string destFolder, bool move, CancellationToken ct)
    {
        var fileName = Path.GetFileName(sourcePath.TrimEnd('\\', '/'));
        if (string.IsNullOrEmpty(fileName))
            return new FileOpResult(false, "잘못된 원본 경로입니다.", null);

        // 원본·대상은 PC(에이전트) 또는 공유 폴더(서버가 직접 접근)
        CopySource source;
        CopyTarget target;
        try
        {
            source = await OpenSourceAsync(sourceAgentId, sourcePath, ct);
            target = OpenTarget(destAgentId);
        }
        catch (CopyException ex)
        {
            return new FileOpResult(false, ex.Message, null);
        }
        if (source.Size < 0)
        {
            // 파일이 아니면 폴더인지 보고 폴더째 복사한다
            source.Dispose();
            return await CrossCopyFolderAsync(sourceAgentId, sourcePath, destAgentId, destFolder, move, ct);
        }
        var size = source.Size;

        // 대상 쪽으로 가는 전송을 기록해 대시보드에 진행 상황을 보여준다
        var transfer = NewTransfer(destAgentId, TransferKind.Push, destFolder.TrimEnd('\\', '/') + "\\" + fileName);
        transfer.TotalBytes = size;
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            db.Transfers.Add(transfer);
            await db.SaveChangesAsync(ct);
        }
        await dashboard.Clients.All.TransferUpdated(transfer.ToView() with { Percent = 0 });

        string? finalPath = null;
        string? failure = null;
        try
        {
            await target.BeginAsync(destFolder, fileName, ct);
            try
            {
                long offset = 0;
                var lastPercent = -1;
                while (offset < size)
                {
                    var want = (int)Math.Min(CrossCopyChunkSize, size - offset);
                    var data = await source.ReadAsync(offset, want, ct);
                    if (data.Length == 0)
                        break;
                    await target.WriteAsync(data, ct);
                    offset += data.Length;

                    var percent = size > 0 ? (int)(offset * 100 / size) : 100;
                    if (percent != lastPercent)
                    {
                        lastPercent = percent;
                        await dashboard.Clients.All.TransferUpdated(transfer.ToView() with { Percent = percent });
                    }
                }
                finalPath = await target.CommitAsync(ct);
            }
            catch
            {
                try { await target.AbortAsync(); }
                catch { /* 정리 실패는 무시 */ }
                throw;
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            failure = ex.Message;
        }
        finally
        {
            source.Dispose();
        }

        // 전송 결과를 기록/브로드캐스트
        await MarkCrossCopyResultAsync(transfer.Id, failure is null, size, failure);
        if (failure is not null)
            return new FileOpResult(false, "대상으로 보내지 못했습니다: " + failure, null);

        // 잘라내기면 원본 삭제
        if (move)
        {
            var del = await DeleteSourceAsync(sourceAgentId, sourcePath, ct);
            if (del is not null)
                return new FileOpResult(true, "복사는 완료됐지만 원본 삭제 실패: " + del, finalPath);
        }

        return new FileOpResult(true, null, finalPath);
    }

    // ── 내 PC 프로그램으로 열기 (편집 PC로 보내고, 저장되면 원래 PC로 되돌림) ──

    /// <summary>
    /// 원래 PC(또는 공유 폴더)의 파일을 편집 PC(대시보드를 연 PC)의 에이전트로 보내 기본 프로그램으로 연다.
    /// 편집 PC 자신의 파일이면 그 자리에서 연다.
    /// </summary>
    /// <returns>오류 문구. 성공하면 null</returns>
    public async Task<string?> OpenLocalAsync(string sourceId, string sourcePath, string editorId, string label, bool readOnly, CancellationToken ct)
    {
        if (!registry.TryGetConnection(editorId, out var editorConn))
            return "내 PC의 에이전트가 오프라인입니다.";
        var editor = agentHubRaw.Clients.Client(editorConn);
        var fileName = Path.GetFileName(sourcePath.TrimEnd('\\', '/'));
        if (string.IsNullOrEmpty(fileName))
            return "잘못된 파일 경로입니다.";

        try
        {
            // 내 PC의 파일: 복사하지 않고 그대로 연다 (압축 안 파일은 아래처럼 꺼내서 연다)
            if (sourceId == editorId && !readOnly)
                return await editor.InvokeAsync<string?>(AgentClientMethods.LaunchFile, sourcePath, ct);

            CopySource source;
            try
            {
                source = await OpenSourceAsync(sourceId, sourcePath, ct);
            }
            catch (CopyException ex)
            {
                return ex.Message;
            }
            using (source)
            {
                if (source.Size < 0)
                    return "파일을 찾을 수 없습니다.";

                var transfer = NewTransfer(editorId, TransferKind.Push, $"{label}\\{fileName}");
                transfer.TotalBytes = source.Size;
                await using (var db = await dbFactory.CreateDbContextAsync(ct))
                {
                    db.Transfers.Add(transfer);
                    await db.SaveChangesAsync(ct);
                }
                await dashboard.Clients.All.TransferUpdated(transfer.ToView() with { Percent = 0 });

                string? failure = null;
                var writeId = await editor.InvokeAsync<string>(AgentClientMethods.PrepareEdit, label, fileName, ct);
                try
                {
                    using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                    long offset = 0;
                    var lastPercent = -1;
                    while (offset < source.Size)
                    {
                        var data = await source.ReadAsync(offset, (int)Math.Min(CrossCopyChunkSize, source.Size - offset), ct);
                        if (data.Length == 0)
                            break;
                        sha.AppendData(data);
                        await editor.InvokeAsync<int>(AgentClientMethods.WriteChunk, writeId, data, ct);
                        offset += data.Length;
                        var percent = source.Size > 0 ? (int)(offset * 100 / source.Size) : 100;
                        if (percent != lastPercent)
                        {
                            lastPercent = percent;
                            await dashboard.Clients.All.TransferUpdated(transfer.ToView() with { Percent = percent });
                        }
                    }
                    var hash = Convert.ToHexString(sha.GetHashAndReset());
                    failure = await editor.InvokeAsync<string?>(
                        AgentClientMethods.OpenEdit, new OpenEditRequest(writeId, sourceId, sourcePath, hash, readOnly), ct);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    try { await editor.InvokeAsync<bool>(AgentClientMethods.AbortWrite, writeId, CancellationToken.None); }
                    catch { /* 정리 실패는 무시 */ }
                    failure = ex.Message;
                }
                await MarkCrossCopyResultAsync(transfer.Id, failure is null, source.Size, failure);
                return failure;
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return Api.TextEndpoints.OldAgentMessage(ex);
        }
    }

    /// <summary>
    /// 편집 PC에서 저장한 내용을 원래 PC의 원래 경로에 쓴다 (원본은 .bak).
    /// 편집하는 동안 원래 파일이 바뀌었으면 덮어쓰지 않고 옆에 "이름 (충돌 날짜).확장자"로 저장한다.
    /// </summary>
    public async Task<EditSaveResult> SaveEditAsync(string sourceId, string sourcePath, string? baseHash, byte[] content, CancellationToken ct)
    {
        var newHash = Convert.ToHexString(SHA256.HashData(content));
        var current = await HashSourceAsync(sourceId, sourcePath, ct);
        if (current == newHash)
            return new EditSaveResult(true, null, newHash, sourcePath, false);

        string? error;
        var savedPath = sourcePath;
        var conflict = baseHash is not null && current is not null && current != baseHash;
        if (conflict)
        {
            var folder = Path.GetDirectoryName(sourcePath) ?? "";
            var name = $"{Path.GetFileNameWithoutExtension(sourcePath)} (충돌 {DateTime.Now:yyyyMMdd-HHmmss}){Path.GetExtension(sourcePath)}";
            try
            {
                var target = OpenTarget(sourceId);
                await target.BeginAsync(folder, name, ct);
                for (var offset = 0; offset < content.Length; offset += CrossCopyChunkSize)
                    await target.WriteAsync(content[offset..Math.Min(content.Length, offset + CrossCopyChunkSize)], ct);
                savedPath = await target.CommitAsync(ct);
                error = null;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                error = ex.Message;
            }
        }
        else if (shares.TryGet(sourceId, out var share))
        {
            error = localShare.ReplaceFile(share, sourcePath, content, backup: true);
        }
        else
        {
            error = await Api.TextEndpoints.WriteToAgentAsync(sourceId, sourcePath, content, backup: true, registry, agentHubRaw, ct);
        }

        // 저장 기록 (전송 기록·PiP에 보이게)
        var transfer = NewTransfer(sourceId, TransferKind.Push, savedPath);
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            db.Transfers.Add(transfer);
            await db.SaveChangesAsync(ct);
        }
        await MarkCrossCopyResultAsync(transfer.Id, error is null, content.Length, error);
        if (error is not null)
            logger.LogWarning("편집 저장 실패 {Path}: {Error}", sourcePath, error);
        return new EditSaveResult(error is null, error, error is null ? newHash : null, savedPath, conflict && error is null);
    }

    /// <summary>원래 파일의 SHA-256. 없거나 못 읽으면 null</summary>
    private async Task<string?> HashSourceAsync(string id, string path, CancellationToken ct)
    {
        try
        {
            using var source = await OpenSourceAsync(id, path, ct);
            if (source.Size < 0)
                return null;
            using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            long offset = 0;
            while (offset < source.Size)
            {
                var data = await source.ReadAsync(offset, (int)Math.Min(CrossCopyChunkSize * 4, source.Size - offset), ct);
                if (data.Length == 0)
                    break;
                sha.AppendData(data);
                offset += data.Length;
            }
            return Convert.ToHexString(sha.GetHashAndReset());
        }
        catch (Exception ex) when (ex is CopyException or IOException or HubException)
        {
            return null;
        }
    }

    /// <summary>
    /// PC·공유 폴더 사이 폴더 복사: 원본 폴더 트리를 훑어 대상에 같은 구조로 만들고 파일을 하나씩 중계한다.
    /// 대상에 같은 이름이 있으면 "이름 (2)"로 만든다. 잘라내기면 다 옮긴 뒤 원본 폴더를 지운다.
    /// </summary>
    private async Task<FileOpResult> CrossCopyFolderAsync(
        string sourceId, string sourcePath, string destId, string destFolder, bool move, CancellationToken ct)
    {
        var folderName = Path.GetFileName(sourcePath.TrimEnd('\\', '/'));
        var root = await ListAsync(sourceId, sourcePath, ct);
        if (root is null || root.Error is not null)
            return new FileOpResult(false, "원본을 찾을 수 없습니다" + (root?.Error is { } e ? $": {e}" : "."), null);

        // 원본 트리 훑기: (원본 전체 경로, 대상 기준 상대 경로, 크기)
        var files = new List<(string Source, string Relative, long Size)>();
        var dirs = new List<string>();
        var pending = new Queue<(DirectoryListing Listing, string Relative)>();
        pending.Enqueue((root, ""));
        while (pending.Count > 0)
        {
            var (listing, relative) = pending.Dequeue();
            foreach (var entry in listing.Entries)
            {
                var childRelative = relative.Length == 0 ? entry.Name : relative + "\\" + entry.Name;
                if (entry.IsDirectory)
                {
                    dirs.Add(childRelative);
                    var child = await ListAsync(sourceId, entry.FullPath, ct);
                    if (child is null || child.Error is not null)
                        return new FileOpResult(false, $"폴더를 읽을 수 없습니다: {entry.FullPath}", null);
                    pending.Enqueue((child, childRelative));
                }
                else
                {
                    files.Add((entry.FullPath, childRelative, entry.Size));
                }
            }
        }

        // 대상 최상위 폴더 (같은 이름이 있으면 새 이름)
        FileOpResult created;
        try
        {
            created = await DestFileOpAsync(destId, new FileOpRequest(FileOpKind.CreateDirectory, destFolder, folderName), ct);
        }
        catch (CopyException ex)
        {
            return new FileOpResult(false, ex.Message, null);
        }
        if (!created.Success || created.ResultPath is null)
            return new FileOpResult(false, "대상 폴더를 만들지 못했습니다: " + created.Error, null);
        var destRoot = created.ResultPath;

        var total = files.Sum(f => Math.Max(0, f.Size));
        var transfer = NewTransfer(destId, TransferKind.Push, destRoot);
        transfer.TotalBytes = total;
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            db.Transfers.Add(transfer);
            await db.SaveChangesAsync(ct);
        }
        await dashboard.Clients.All.TransferUpdated(transfer.ToView() with { Percent = 0 });

        string? failure = null;
        long done = 0;
        var lastPercent = -1;
        try
        {
            // 빈 폴더도 남도록 하위 폴더를 먼저 만든다 (상위부터)
            foreach (var dir in dirs)
            {
                var parent = Path.GetDirectoryName(dir);
                var result = await DestFileOpAsync(destId, new FileOpRequest(FileOpKind.CreateDirectory,
                    string.IsNullOrEmpty(parent) ? destRoot : destRoot + "\\" + parent, Path.GetFileName(dir)), ct);
                if (!result.Success)
                    throw new IOException($"폴더를 만들지 못했습니다: {dir} ({result.Error})");
            }

            foreach (var (sourceFile, relative, _) in files)
            {
                using var source = await OpenSourceAsync(sourceId, sourceFile, ct);
                if (source.Size < 0)
                    throw new IOException($"파일을 읽을 수 없습니다: {sourceFile}");
                var target = OpenTarget(destId);
                var parent = Path.GetDirectoryName(relative);
                await target.BeginAsync(string.IsNullOrEmpty(parent) ? destRoot : destRoot + "\\" + parent, Path.GetFileName(relative), ct);
                try
                {
                    long offset = 0;
                    while (offset < source.Size)
                    {
                        var data = await source.ReadAsync(offset, (int)Math.Min(CrossCopyChunkSize, source.Size - offset), ct);
                        if (data.Length == 0)
                            break;
                        await target.WriteAsync(data, ct);
                        offset += data.Length;
                        done += data.Length;
                        var percent = total > 0 ? (int)(done * 100 / total) : 100;
                        if (percent != lastPercent)
                        {
                            lastPercent = percent;
                            await dashboard.Clients.All.TransferUpdated(transfer.ToView() with { Percent = percent, FileCount = 0 });
                        }
                    }
                    await target.CommitAsync(ct);
                }
                catch
                {
                    try { await target.AbortAsync(); }
                    catch { /* 정리 실패는 무시 */ }
                    throw;
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            failure = ex is CopyException or IOException ? ex.Message : Api.TextEndpoints.OldAgentMessage(ex);
        }

        await MarkCrossCopyResultAsync(transfer.Id, failure is null, done, failure);
        if (failure is not null)
            return new FileOpResult(false, $"폴더 복사 중 실패 ({files.Count}개 중 일부만 복사됨): {failure}", destRoot);

        if (move)
        {
            var del = await DeleteSourceAsync(sourceId, sourcePath, ct);
            if (del is not null)
                return new FileOpResult(true, "복사는 완료됐지만 원본 삭제 실패: " + del, destRoot);
        }
        return new FileOpResult(true, null, destRoot);
    }

    /// <summary>PC 또는 공유 폴더의 목록 (압축 안 폴더 포함). 없으면 null</summary>
    private async Task<DirectoryListing?> ListAsync(string id, string path, CancellationToken ct)
    {
        if (shares.TryGet(id, out var share))
            return localShare.ListDirectory(share, path);
        if (!registry.TryGetConnection(id, out var conn))
            throw new CopyException("원본 PC가 오프라인입니다.");
        try
        {
            return await agentHubRaw.Clients.Client(conn).InvokeAsync<DirectoryListing>(AgentClientMethods.ListDirectory, path, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new DirectoryListing(path, null, [], ex.Message);
        }
    }

    /// <summary>대상(PC 또는 공유 폴더)에서 파일 조작 (폴더 만들기 등)</summary>
    private async Task<FileOpResult> DestFileOpAsync(string id, FileOpRequest request, CancellationToken ct)
    {
        if (shares.TryGet(id, out var share))
            return localShare.PerformFileOp(share, request);
        if (!registry.TryGetConnection(id, out var conn))
            throw new CopyException("대상 PC가 오프라인입니다.");
        return await agentHubRaw.Clients.Client(conn).InvokeAsync<FileOpResult>(AgentClientMethods.FileOp, request, ct);
    }

    private sealed class CopyException(string message) : Exception(message);

    /// <summary>복사 원본: 크기와 구간 읽기</summary>
    private sealed class CopySource(long size, Func<long, int, CancellationToken, Task<byte[]>> read, IDisposable? owned = null) : IDisposable
    {
        public long Size => size;
        public Task<byte[]> ReadAsync(long offset, int length, CancellationToken ct) => read(offset, length, ct);
        public void Dispose() => owned?.Dispose();
    }

    /// <summary>복사 대상: 임시 파일에 순서대로 쓰고 확정</summary>
    private sealed class CopyTarget
    {
        public required Func<string, string, CancellationToken, Task> BeginAsync { get; init; }
        public required Func<byte[], CancellationToken, Task> WriteAsync { get; init; }
        public required Func<CancellationToken, Task<string>> CommitAsync { get; init; }
        public required Func<Task> AbortAsync { get; init; }
    }

    private async Task<CopySource> OpenSourceAsync(string id, string path, CancellationToken ct)
    {
        if (shares.TryGet(id, out var share))
        {
            var stream = localShare.OpenRead(share, path);
            if (stream is null)
                return new CopySource(-1, (_, _, _) => Task.FromResult(Array.Empty<byte>()));
            return new CopySource(stream.Length, async (offset, length, token) =>
            {
                stream.Position = offset;
                var buffer = new byte[length];
                var total = 0;
                while (total < length)
                {
                    var read = await stream.ReadAsync(buffer.AsMemory(total), token);
                    if (read == 0)
                        break;
                    total += read;
                }
                return total == length ? buffer : buffer[..total];
            }, stream);
        }

        if (!registry.TryGetConnection(id, out var conn))
            throw new CopyException("원본 PC가 오프라인입니다.");
        var proxy = agentHubRaw.Clients.Client(conn);
        long size;
        try
        {
            size = await proxy.InvokeAsync<long>(AgentClientMethods.GetFileSize, path, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            throw new CopyException("원본을 열 수 없습니다: " + ex.Message);
        }
        return new CopySource(size, (offset, length, token) =>
            proxy.InvokeAsync<byte[]>(AgentClientMethods.ReadFileChunk, path, offset, length, token));
    }

    private CopyTarget OpenTarget(string id)
    {
        if (shares.TryGet(id, out var share))
        {
            FileStream? stream = null;
            string? tempPath = null;
            string? finalPath = null;
            return new CopyTarget
            {
                BeginAsync = (folder, name, _) =>
                {
                    (stream, tempPath, finalPath) = localShare.BeginWrite(share, folder, name);
                    return Task.CompletedTask;
                },
                WriteAsync = (data, token) => stream!.WriteAsync(data, token).AsTask(),
                CommitAsync = async _ =>
                {
                    await stream!.DisposeAsync();
                    localShare.CommitWrite(share, tempPath!, finalPath!);
                    return finalPath!;
                },
                AbortAsync = async () =>
                {
                    if (stream is not null)
                        await stream.DisposeAsync();
                    if (tempPath is not null)
                        localShare.AbortWrite(share, tempPath);
                },
            };
        }

        if (!registry.TryGetConnection(id, out var conn))
            throw new CopyException("대상 PC가 오프라인입니다.");
        var proxy = agentHubRaw.Clients.Client(conn);
        string? writeId = null;
        return new CopyTarget
        {
            BeginAsync = async (folder, name, token) =>
                writeId = await proxy.InvokeAsync<string>(AgentClientMethods.BeginWrite, folder, name, token),
            WriteAsync = (data, token) => proxy.InvokeAsync<int>(AgentClientMethods.WriteChunk, writeId!, data, token),
            CommitAsync = token => proxy.InvokeAsync<string>(AgentClientMethods.CommitWrite, writeId!, token),
            AbortAsync = async () =>
            {
                if (writeId is not null)
                    await proxy.InvokeAsync<bool>(AgentClientMethods.AbortWrite, writeId, CancellationToken.None);
            },
        };
    }

    /// <returns>실패하면 오류 문구</returns>
    private async Task<string?> DeleteSourceAsync(string id, string path, CancellationToken ct)
    {
        try
        {
            FileOpResult result;
            if (shares.TryGet(id, out var share))
            {
                result = localShare.PerformFileOp(share, new FileOpRequest(FileOpKind.Delete, path, null));
            }
            else
            {
                if (!registry.TryGetConnection(id, out var conn))
                    return "원본 PC가 오프라인입니다.";
                result = await agentHubRaw.Clients.Client(conn)
                    .InvokeAsync<FileOpResult>(AgentClientMethods.FileOp, new FileOpRequest(FileOpKind.Delete, path, null), ct);
            }
            return result.Success ? null : result.Error;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return ex.Message;
        }
    }

    private async Task MarkCrossCopyResultAsync(string transferId, bool success, long totalBytes, string? error)
    {
        TransferEntity? transfer;
        await using (var db = await dbFactory.CreateDbContextAsync())
        {
            transfer = await db.Transfers.FirstOrDefaultAsync(t => t.Id == transferId);
            if (transfer is null)
                return;
            transfer.State = success ? TransferState.Succeeded : TransferState.Failed;
            transfer.FileCount = success ? 1 : 0;
            transfer.TotalBytes = totalBytes;
            transfer.Error = error;
            transfer.FinishedAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
        }
        await dashboard.Clients.All.TransferUpdated(transfer.ToView());
    }

    /// <summary>파일 탐색기: PC 안에서 선택 항목을 ZIP으로 압축한다 (PC에서 직접 수행). splitBytes>0이면 분할 압축.</summary>
    public async Task<TransferView> CompressAsync(string agentId, IReadOnlyList<string> paths, string destFolder, string archiveName, long splitBytes = 0)
    {
        var target = destFolder.TrimEnd('\\', '/') + "\\" + archiveName;
        var transfer = NewTransfer(agentId, TransferKind.Compress, target);
        await DispatchAsync(transfer, client => client.Compress(new CompressRequest(transfer.Id, paths, destFolder, archiveName, splitBytes)));
        return transfer.ToView();
    }

    /// <summary>파일 탐색기: 압축 파일 안 항목(비면 전부)을 같은 PC의 폴더에 푼다 (PC에서 직접 수행).</summary>
    public async Task<TransferView> ExtractAsync(string agentId, string archivePath, IReadOnlyList<string> entryPaths, string destFolder)
    {
        var transfer = NewTransfer(agentId, TransferKind.Extract, destFolder);
        await DispatchAsync(transfer, client => client.Extract(new ExtractRequest(transfer.Id, archivePath, entryPaths, destFolder)));
        return transfer.ToView();
    }

    /// <summary>오래 걸리는 전송(압축 등)의 진행 상황을 대시보드에 중계한다 (DB에는 남기지 않음).</summary>
    public async Task MarkProgressAsync(string agentId, TransferProgressReport report)
    {
        var transfer = await FindAsync(report.TransferId);
        if (transfer is null || transfer.AgentId != agentId || transfer.State != TransferState.Pending)
            return;
        await dashboard.Clients.All.TransferUpdated(transfer.ToView() with { FileCount = report.FileCount, Percent = report.Percent });
    }

    /// <summary>Job 단계: PC의 결과 파일을 수집하고 끝날 때까지 기다린다.</summary>
    public async Task<TransferEntity> CollectAndWaitAsync(
        string agentId, string jobRunId, int stepIndex, string? sourceDirectory, IReadOnlyList<string> patterns, CancellationToken ct)
    {
        var transfer = NewTransfer(agentId, TransferKind.Collect, sourceDirectory);
        transfer.JobRunId = jobRunId;
        transfer.StepIndex = stepIndex;
        transfer.Patterns = [.. patterns];

        var completion = notifier.WaitAsync(transfer.Id, ct);
        await DispatchAsync(transfer, client =>
            client.CollectFiles(new CollectFilesRequest(transfer.Id, sourceDirectory, patterns, jobRunId)));
        await completion;

        return await FindAsync(transfer.Id) ?? transfer;
    }

    /// <summary>공유 폴더(서버 직접 접근)의 파일을 가져오기: 서버가 아티팩트로 저장해 다운로드할 수 있게 한다.</summary>
    public async Task<TransferView> FetchLocalAsync(string sourceId, string sourcePath, Stream content, long size, CancellationToken ct)
    {
        var fileName = Path.GetFileName(sourcePath.TrimEnd('\\', '/'));
        var transfer = NewTransfer(sourceId, TransferKind.Fetch, sourcePath);
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            db.Transfers.Add(transfer);
            await db.SaveChangesAsync(ct);
        }
        await dashboard.Clients.All.TransferUpdated(transfer.ToView());
        try
        {
            await SaveUploadedFileAsync(transfer.Id, fileName, content, ct);
            await MarkCompletedAsync(sourceId, new TransferCompleted(transfer.Id, true, 1, size, null, DateTime.UtcNow));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            await MarkCompletedAsync(sourceId, new TransferCompleted(transfer.Id, false, 0, 0, ex.Message, DateTime.UtcNow));
        }
        return (await FindAsync(transfer.Id))?.ToView() ?? transfer.ToView();
    }

    /// <summary>공유 폴더에서 서버가 이미 끝낸 작업(올리기·압축)을 전송 기록에 남긴다.</summary>
    public async Task<TransferView> RecordLocalDoneAsync(string sourceId, TransferKind kind, string path, long size)
    {
        var transfer = NewTransfer(sourceId, kind, path);
        transfer.State = TransferState.Succeeded;
        transfer.FileCount = 1;
        transfer.TotalBytes = size;
        transfer.FinishedAt = DateTime.UtcNow;
        await using (var db = await dbFactory.CreateDbContextAsync())
        {
            db.Transfers.Add(transfer);
            await db.SaveChangesAsync();
        }
        await dashboard.Clients.All.TransferUpdated(transfer.ToView());
        return transfer.ToView();
    }

    /// <summary>파일 탐색기: PC의 파일을 서버로 가져온다.</summary>
    public async Task<TransferView> FetchAsync(string agentId, string sourcePath)
    {
        var transfer = NewTransfer(agentId, TransferKind.Fetch, sourcePath);
        await DispatchAsync(transfer, client => client.UploadFile(new UploadFileRequest(transfer.Id, sourcePath)));
        return transfer.ToView();
    }

    /// <summary>파일 탐색기: 받은 파일을 서버에 저장한 뒤 PC가 내려받게 한다.</summary>
    public async Task<TransferView> PushAsync(string agentId, string destinationPath, Stream content, CancellationToken ct)
    {
        var transfer = NewTransfer(agentId, TransferKind.Push, destinationPath);
        transfer.TotalBytes = await store.SaveAsync(store.GetPushContentPath(transfer.Id), content, ct);
        await DispatchAsync(transfer, client => client.DownloadFile(new DownloadFileRequest(transfer.Id, destinationPath)));
        return transfer.ToView();
    }

    /// <summary>에이전트가 올린 파일을 저장한다.</summary>
    public async Task<ArtifactView> SaveUploadedFileAsync(string transferId, string relativePath, Stream body, CancellationToken ct)
    {
        var transfer = await FindAsync(transferId);
        if (transfer is null || transfer.State != TransferState.Pending || transfer.Kind == TransferKind.Push)
            throw new InvalidOperationException("업로드를 받을 수 없는 전송입니다.");

        var normalized = ArtifactStore.NormalizeRelativePath(relativePath);
        var path = store.GetArtifactPath(transferId, normalized);
        var size = await store.SaveAsync(path, body, ct);
        var junit = ArtifactStore.TryParseJUnit(path);

        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var artifact = await db.Artifacts.FirstOrDefaultAsync(a => a.TransferId == transferId && a.RelativePath == normalized, ct)
            ?? db.Artifacts.Add(new ArtifactEntity
            {
                Id = Guid.NewGuid().ToString("N"),
                TransferId = transferId,
                AgentId = transfer.AgentId,
                JobRunId = transfer.JobRunId,
                RelativePath = normalized,
            }).Entity;
        artifact.Size = size;
        artifact.CreatedAt = DateTime.UtcNow;
        artifact.TestsTotal = junit?.Total;
        artifact.TestsFailed = junit?.Failed;
        artifact.TestsSkipped = junit?.Skipped;
        await db.SaveChangesAsync(ct);
        return artifact.ToView();
    }

    /// <summary>에이전트가 내려받을 파일 경로. 받을 수 없는 상태면 null.</summary>
    public async Task<string?> GetPushContentPathAsync(string transferId)
    {
        var transfer = await FindAsync(transferId);
        if (transfer is not { Kind: TransferKind.Push, State: TransferState.Pending })
            return null;
        var path = store.GetPushContentPath(transferId);
        return File.Exists(path) ? path : null;
    }

    public async Task MarkCompletedAsync(string agentId, TransferCompleted completed)
    {
        TransferEntity? transfer;
        await using (var db = await dbFactory.CreateDbContextAsync())
        {
            transfer = await db.Transfers.FirstOrDefaultAsync(t => t.Id == completed.TransferId && t.AgentId == agentId);
            if (transfer is null || transfer.State != TransferState.Pending)
                return;

            transfer.State = completed.Success ? TransferState.Succeeded : TransferState.Failed;
            transfer.FileCount = completed.FileCount;
            transfer.TotalBytes = completed.TotalBytes;
            transfer.Error = completed.Error;
            transfer.FinishedAt = completed.FinishedAt;
            await db.SaveChangesAsync();
        }

        if (transfer.Kind == TransferKind.Push)
            DeletePushContent(transfer.Id);

        notifier.Complete(transfer.Id);
        await dashboard.Clients.All.TransferUpdated(transfer.ToView());
    }

    /// <summary>에이전트 재등록 시, 에이전트가 모르는 대기 중 전송을 실패 처리한다.</summary>
    public async Task FailOrphanedAsync(string agentId, IReadOnlyCollection<string> unreportedIds)
    {
        List<TransferEntity> orphaned;
        await using (var db = await dbFactory.CreateDbContextAsync())
        {
            orphaned = await db.Transfers
                .Where(t => t.AgentId == agentId && t.State == TransferState.Pending)
                .ToListAsync();
            orphaned.RemoveAll(t => unreportedIds.Contains(t.Id));
            if (orphaned.Count == 0)
                return;

            var now = DateTime.UtcNow;
            foreach (var transfer in orphaned)
            {
                transfer.State = TransferState.Failed;
                transfer.Error = "에이전트가 재시작되었거나 요청을 받지 못해 결과를 알 수 없습니다.";
                transfer.FinishedAt = now;
            }
            await db.SaveChangesAsync();
        }

        foreach (var transfer in orphaned)
        {
            if (transfer.Kind == TransferKind.Push)
                DeletePushContent(transfer.Id);
            notifier.Complete(transfer.Id);
            await dashboard.Clients.All.TransferUpdated(transfer.ToView());
        }
    }

    private async Task<TransferEntity?> FindAsync(string transferId)
    {
        await using var db = await dbFactory.CreateDbContextAsync();
        return await db.Transfers.AsNoTracking().FirstOrDefaultAsync(t => t.Id == transferId);
    }

    private TransferEntity NewTransfer(string agentId, TransferKind kind, string? path) => new()
    {
        Id = Guid.NewGuid().ToString("N"),
        AgentId = agentId,
        Kind = kind,
        Path = path,
        State = TransferState.Pending,
        CreatedAt = DateTime.UtcNow,
        StartedByUserId = CurrentUserId(),
    };

    /// <summary>현재 HTTP 요청 헤더(X-User-Id)에서 실행 사용자 id를 읽는다. 없으면 null.</summary>
    private string? CurrentUserId()
    {
        var value = httpContext.HttpContext?.Request.Headers["X-User-Id"].ToString();
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }

    private async Task DispatchAsync(TransferEntity transfer, Func<IAgentClient, Task> send)
    {
        var online = registry.TryGetConnection(transfer.AgentId, out var connectionId);
        if (!online)
        {
            transfer.State = TransferState.Failed;
            transfer.Error = "에이전트가 오프라인입니다.";
            transfer.FinishedAt = DateTime.UtcNow;
        }

        await using (var db = await dbFactory.CreateDbContextAsync())
        {
            db.Transfers.Add(transfer);
            await db.SaveChangesAsync();
        }

        if (online)
        {
            await send(agentHub.Clients.Client(connectionId));
        }
        else
        {
            if (transfer.Kind == TransferKind.Push)
                DeletePushContent(transfer.Id);
            notifier.Complete(transfer.Id);
        }

        await dashboard.Clients.All.TransferUpdated(transfer.ToView());
    }

    private void DeletePushContent(string transferId)
    {
        try
        {
            var directory = Path.GetDirectoryName(store.GetPushContentPath(transferId))!;
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
        catch (IOException ex)
        {
            logger.LogWarning(ex, "전송 임시 파일 삭제 실패 {TransferId}", transferId);
        }
    }
}
