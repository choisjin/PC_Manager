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
    IHubContext<DashboardHub, IDashboardClient> dashboard,
    ILogger<TransferService> logger)
{
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
