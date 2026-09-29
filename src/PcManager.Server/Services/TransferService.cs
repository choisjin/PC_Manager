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
    ILogger<TransferService> logger)
{
    // PC 간 직접 전송 시 한 번에 옮기는 조각 크기 (서버 디스크를 거치지 않고 원본→대상으로 중계)
    private const int CrossCopyChunkSize = 256 * 1024;

    /// <summary>
    /// PC 간 파일 붙여넣기: 원본 PC에서 읽은 조각을 서버 디스크에 저장하지 않고 곧바로 대상 PC로 흘려보낸다.
    /// (에이전트는 서버로 아웃바운드 연결만 하므로 P2P 대신 서버가 조각을 중계한다.)
    /// 단일 파일만 지원한다. 잘라내기면 완료 후 원본을 지운다.
    /// </summary>
    public async Task<FileOpResult> CrossCopyAsync(
        string sourceAgentId, string sourcePath, string destAgentId, string destFolder, bool move, CancellationToken ct)
    {
        var fileName = Path.GetFileName(sourcePath.TrimEnd('\\', '/'));
        if (string.IsNullOrEmpty(fileName))
            return new FileOpResult(false, "잘못된 원본 경로입니다.", null);
        if (!registry.TryGetConnection(sourceAgentId, out var sourceConn))
            return new FileOpResult(false, "원본 PC가 오프라인입니다.", null);
        if (!registry.TryGetConnection(destAgentId, out var destConn))
            return new FileOpResult(false, "대상 PC가 오프라인입니다.", null);

        var source = agentHubRaw.Clients.Client(sourceConn);
        var dest = agentHubRaw.Clients.Client(destConn);

        long size;
        try
        {
            size = await source.InvokeAsync<long>(AgentClientMethods.GetFileSize, sourcePath, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new FileOpResult(false, "원본을 열 수 없습니다: " + ex.Message, null);
        }
        if (size < 0)
            return new FileOpResult(false, "원본 파일을 찾을 수 없습니다 (폴더는 PC 간 복사를 지원하지 않습니다).", null);

        // 대상 PC로 가는 전송을 기록해 대시보드에 진행 상황을 보여준다
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
            var writeId = await dest.InvokeAsync<string>(AgentClientMethods.BeginWrite, destFolder, fileName, ct);
            try
            {
                long offset = 0;
                var lastPercent = -1;
                while (offset < size)
                {
                    var want = (int)Math.Min(CrossCopyChunkSize, size - offset);
                    var data = await source.InvokeAsync<byte[]>(AgentClientMethods.ReadFileChunk, sourcePath, offset, want, ct);
                    if (data.Length == 0)
                        break;
                    await dest.InvokeAsync<int>(AgentClientMethods.WriteChunk, writeId, data, ct);
                    offset += data.Length;

                    var percent = size > 0 ? (int)(offset * 100 / size) : 100;
                    if (percent != lastPercent)
                    {
                        lastPercent = percent;
                        await dashboard.Clients.All.TransferUpdated(transfer.ToView() with { Percent = percent });
                    }
                }
                finalPath = await dest.InvokeAsync<string>(AgentClientMethods.CommitWrite, writeId, ct);
            }
            catch
            {
                try { await dest.InvokeAsync<bool>(AgentClientMethods.AbortWrite, writeId, CancellationToken.None); }
                catch { /* 정리 실패는 무시 */ }
                throw;
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            failure = ex.Message;
        }

        // 전송 결과를 기록/브로드캐스트
        await MarkCrossCopyResultAsync(transfer.Id, failure is null, size, failure);
        if (failure is not null)
            return new FileOpResult(false, "대상 PC로 보내지 못했습니다: " + failure, null);

        // 잘라내기면 원본 삭제
        if (move)
        {
            try
            {
                var del = await source.InvokeAsync<FileOpResult>(
                    AgentClientMethods.FileOp, new FileOpRequest(FileOpKind.Delete, sourcePath, null), ct);
                if (!del.Success)
                    return new FileOpResult(true, "복사는 완료됐지만 원본 삭제 실패: " + del.Error, finalPath);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return new FileOpResult(true, "복사는 완료됐지만 원본 삭제 실패: " + ex.Message, finalPath);
            }
        }

        return new FileOpResult(true, null, finalPath);
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

    private static TransferEntity NewTransfer(string agentId, TransferKind kind, string? path) => new()
    {
        Id = Guid.NewGuid().ToString("N"),
        AgentId = agentId,
        Kind = kind,
        Path = path,
        State = TransferState.Pending,
        CreatedAt = DateTime.UtcNow,
    };

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
