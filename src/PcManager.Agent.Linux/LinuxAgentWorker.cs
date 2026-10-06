using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using PcManager.Agent.Linux.Remote;
using PcManager.Shared;

namespace PcManager.Agent.Linux;

/// <summary>
/// 서버 연결 유지, 명령 수신, 보고 큐 전송 (Windows AgentWorker와 같은 흐름).
/// Windows 전용 기능(내 PC 프로그램으로 열기, 셸 아이콘, Ctrl+Alt+Del)은 지원하지 않는다고 답한다.
/// </summary>
public class LinuxAgentWorker(
    AgentSettingsStore settingsStore,
    AgentStatusTracker status,
    AgentIdentity identity,
    CommandRunner runner,
    FileTransferService files,
    VideoTrimmer trimmer,
    LinuxRemoteControl remote,
    LinuxAgentUpdater updater,
    OutboundQueue outbound,
    ILogger<LinuxAgentWorker> logger) : BackgroundService
{
    private const int MaxOutputBatch = 500;
    private const string NotSupported = "Linux 에이전트에서는 지원하지 않는 기능입니다.";
    private static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(5);

    private volatile HubConnection? _connection;
    private volatile bool _registered;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("에이전트 시작 (AgentId={AgentId}, 버전 {Version})", identity.AgentId, AgentStatusTracker.AgentVersionText);
        var pump = PumpOutboundAsync(stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            var changed = settingsStore.WhenChanged;
            var settings = settingsStore.Current;

            if (!settings.HasServer || !settings.Enabled)
            {
                status.SetStatus(settings.HasServer ? ConnectionStatus.Disconnected : ConnectionStatus.NotConfigured);
                logger.LogWarning(settings.HasServer
                    ? "연결 끊김 상태"
                    : "서버 주소가 없습니다. sudo pcmanager-agent --set-server http://서버주소:포트");
                try
                {
                    await changed.WaitAsync(stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                continue;
            }

            using var session = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
            await using var connection = CreateConnection(settings, session.Token);
            _registered = false;
            _connection = connection;
            try
            {
                await RunConnectionAsync(connection, settings, changed, session.Token);
            }
            finally
            {
                _connection = null;
                _registered = false;
                await session.CancelAsync();
            }
        }

        try
        {
            await pump;
        }
        catch (OperationCanceledException)
        {
            // 종료
        }
    }

    private async Task RunConnectionAsync(HubConnection connection, AgentSettings settings, Task changed, CancellationToken ct)
    {
        logger.LogInformation("서버 연결 시작: {ServerUrl}", settings.ServerUrl);
        status.SetStatus(ConnectionStatus.Connecting);

        while (!ct.IsCancellationRequested && !changed.IsCompleted)
        {
            try
            {
                if (connection.State == HubConnectionState.Disconnected)
                    await connection.StartAsync(ct);
                if (connection.State == HubConnectionState.Connected && !_registered)
                    await RegisterAsync(connection, settings, ct);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                status.SetStatus(ConnectionStatus.Connecting, ex.Message);
                logger.LogWarning("서버 접속 실패: {Message}", ex.Message);
            }

            await Task.WhenAny(changed, Task.Delay(RetryInterval, ct));
        }
    }

    private HubConnection CreateConnection(AgentSettings settings, CancellationToken ct)
    {
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(new Uri(settings.ServerUrl), HubPaths.Agent), o =>
            {
                if (!string.IsNullOrEmpty(settings.Token))
                    o.Headers[AgentHeaders.Token] = settings.Token;
            })
            .WithAutomaticReconnect(new ForeverRetryPolicy())
            .Build();

        // 명령 실행 (bash)
        connection.On<RunCommandRequest>(nameof(IAgentClient.RunCommand), request =>
        {
            logger.LogInformation("명령 수신 {RunId}: {CommandLine}", request.RunId, request.CommandLine);
            runner.Start(request);
        });
        connection.On<string>(nameof(IAgentClient.CancelCommand), runner.Cancel);

        // 파일: 탐색·전송·압축 (Windows와 같은 FileTransferService)
        connection.On<CollectFilesRequest>(nameof(IAgentClient.CollectFiles), files.StartCollect);
        connection.On<UploadFileRequest>(nameof(IAgentClient.UploadFile), files.StartUpload);
        connection.On<DownloadFileRequest>(nameof(IAgentClient.DownloadFile), files.StartDownload);
        connection.On<CompressRequest>(nameof(IAgentClient.Compress), files.StartCompress);
        connection.On<ExtractRequest>(nameof(IAgentClient.Extract), files.StartExtract);
        connection.On<CommitReplaceRequest, string?>(AgentClientMethods.CommitReplace, files.CommitReplaceAsync);
        connection.On<string, string, bool>(AgentClientMethods.SetArchivePassword,
            (archivePath, password) => { ArchiveBrowser.SetPassword(archivePath, password); return true; });
        connection.On<string?, DirectoryListing>(AgentClientMethods.ListDirectory,
            path => Task.Run(() => files.ListDirectory(path)));
        connection.On<string, long>(AgentClientMethods.GetFileSize,
            path => Task.Run(() => files.GetFileSize(path)));
        connection.On<string, double, double, VideoTrimResult>(AgentClientMethods.TrimVideo,
            (path, start, end) => trimmer.TrimAsync(path, start, end));
        connection.On<string, long, int, byte[]>(AgentClientMethods.ReadFileChunk,
            (path, offset, length) => Task.Run(() => files.ReadFileChunk(path, offset, length)));
        connection.On<FileOpRequest, FileOpResult>(AgentClientMethods.FileOp,
            request => Task.Run(() => files.PerformFileOp(request)));
        connection.On<string, string, string>(AgentClientMethods.BeginWrite,
            (folder, name) => Task.Run(() => files.BeginWrite(folder, name)));
        connection.On<string, byte[], int>(AgentClientMethods.WriteChunk,
            (writeId, data) => files.WriteChunkAsync(writeId, data));
        connection.On<string, string>(AgentClientMethods.CommitWrite,
            writeId => files.CommitWriteAsync(writeId));
        connection.On<string, bool>(AgentClientMethods.AbortWrite,
            writeId => files.AbortWriteAsync(writeId));

        // 원격조작·썸네일: X11 세션 환경으로 도우미 프로세스를 띄운다
        connection.On<string, string?>(AgentClientMethods.StartRemote,
            sessionId => Task.Run(() => remote.Start(sessionId)));
        connection.On<string, string?>(AgentClientMethods.StartThumbnail,
            sessionId => Task.Run(() => remote.Start(sessionId, thumbnail: true)));
        connection.On<string?>(AgentClientMethods.SendSecureAttention, () => NotSupported);
        connection.On<string?>(AgentClientMethods.SwitchToX11, () => X11Session.SwitchAndReboot(logger));

        connection.On<string?>(nameof(IAgentClient.UpdateAgent), _ => updater.Start());

        // Windows 대시보드 PC 전용 기능 (이 PC에서 대시보드를 열지 않으므로)
        connection.On(AgentClientMethods.PrepareEdit,
            (Func<string, string, string>)((_, _) => throw new HubException(NotSupported)));
        connection.On<OpenEditRequest, string?>(AgentClientMethods.OpenEdit, _ => NotSupported);
        connection.On<string, string?>(AgentClientMethods.LaunchFile, _ => NotSupported);
        connection.On(AgentClientMethods.GetEditFolderInfo, () => new EditFolderInfo(null, 0, 0, 0));
        connection.On<string?>(AgentClientMethods.OpenEditFolder, () => NotSupported);
        connection.On(AgentClientMethods.CleanEditFolder, () => new EditCleanResult(0, 0, 0, 0, new EditFolderInfo(null, 0, 0, 0)));
        connection.On(AgentClientMethods.GetFileIcon, (Func<string, int, byte[]?>)((_, _) => null));

        connection.Reconnecting += error =>
        {
            _registered = false;
            status.SetStatus(ConnectionStatus.Connecting, error?.Message);
            logger.LogWarning("서버 연결 끊김, 재접속 중: {Message}", error?.Message);
            return Task.CompletedTask;
        };
        connection.Reconnected += async _ =>
        {
            try
            {
                await RegisterAsync(connection, settings, ct);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                logger.LogWarning("재등록 실패: {Message}", ex.Message);
            }
        };
        connection.Closed += error =>
        {
            _registered = false;
            if (!ct.IsCancellationRequested)
                status.SetStatus(ConnectionStatus.Connecting, error?.Message);
            return Task.CompletedTask;
        };

        return connection;
    }

    private async Task RegisterAsync(HubConnection connection, AgentSettings settings, CancellationToken ct)
    {
        string[] unreportedIds = [.. runner.UnreportedRunIds, .. files.UnreportedTransferIds];
        await connection.InvokeAsync(AgentHubMethods.Register, identity.CreateInfo(), unreportedIds, ct);
        _registered = true;
        status.SetStatus(ConnectionStatus.Connected);
        logger.LogInformation("서버에 등록됨: {ServerUrl}", settings.ServerUrl);
    }

    private async Task PumpOutboundAsync(CancellationToken ct)
    {
        var reader = outbound.Reader;
        var batch = new List<CommandOutput>(MaxOutputBatch);

        while (await reader.WaitToReadAsync(ct))
        {
            batch.Clear();
            object? message = null;
            while (batch.Count < MaxOutputBatch && reader.TryRead(out var item))
            {
                if (item is CommandOutput line)
                {
                    batch.Add(line);
                }
                else
                {
                    message = item;
                    break;
                }
            }

            if (batch.Count > 0)
                await SendAsync(AgentHubMethods.ReportOutput, batch, ct);

            switch (message)
            {
                case CommandStarted started:
                    await SendAsync(AgentHubMethods.ReportStarted, started, ct);
                    break;
                case CommandCompleted completed:
                    await SendAsync(AgentHubMethods.ReportCompleted, completed, ct);
                    runner.MarkReported(completed.RunId);
                    break;
                case TransferCompleted transfer:
                    await SendAsync(AgentHubMethods.ReportTransferCompleted, transfer, ct);
                    files.MarkReported(transfer.TransferId);
                    break;
                case TransferProgressReport progress:
                    await SendAsync(AgentHubMethods.ReportTransferProgress, progress, ct);
                    break;
                case null when batch.Count > 0:
                    await Task.Delay(100, ct);
                    break;
            }
        }
    }

    private async Task SendAsync(string method, object payload, CancellationToken ct)
    {
        while (true)
        {
            var connection = _connection;
            if (connection is null || !_registered || connection.State != HubConnectionState.Connected)
            {
                await Task.Delay(500, ct);
                continue;
            }

            try
            {
                await connection.InvokeAsync(method, payload, ct);
                return;
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                logger.LogWarning("{Method} 전송 실패, 재시도: {Message}", method, ex.Message);
                await Task.Delay(1000, ct);
            }
        }
    }

    private sealed class ForeverRetryPolicy : IRetryPolicy
    {
        public TimeSpan? NextRetryDelay(RetryContext retryContext) => retryContext.PreviousRetryCount switch
        {
            0 => TimeSpan.Zero,
            < 5 => TimeSpan.FromSeconds(2),
            _ => TimeSpan.FromSeconds(10),
        };
    }
}
