using Microsoft.AspNetCore.SignalR.Client;
using PcManager.Shared;

namespace PcManager.Agent;

/// <summary>
/// 서버 연결 유지, 명령 수신, 보고 큐 전송을 담당한다.
/// 런처에서 서버 주소를 바꾸거나 연결을 끊으면 연결을 새로 만든다.
/// </summary>
public class AgentWorker(
    AgentSettingsStore settingsStore,
    AgentStatusTracker status,
    AgentIdentity identity,
    CommandRunner runner,
    FileTransferService files,
    OutboundQueue outbound,
    ILogger<AgentWorker> logger) : BackgroundService
{
    private const int MaxOutputBatch = 500;
    private static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(5);

    private volatile HubConnection? _connection;
    private volatile bool _registered;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("에이전트 시작 (AgentId={AgentId}, 버전 {Version})", identity.AgentId, AgentStatusTracker.AgentVersionText);
        var pump = PumpOutboundAsync(stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            // 변경 신호를 먼저 잡아야 읽은 뒤에 바뀐 설정을 놓치지 않는다
            var changed = settingsStore.WhenChanged;
            var settings = settingsStore.Current;

            if (!settings.HasServer || !settings.Enabled)
            {
                status.SetStatus(settings.HasServer ? ConnectionStatus.Disconnected : ConnectionStatus.NotConfigured);
                logger.LogInformation(settings.HasServer ? "연결 끊김 상태 (런처에서 연결 대기)" : "서버 주소 없음 (런처에서 입력 대기)");
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

    /// <summary>설정이 바뀌거나 종료될 때까지 접속과 등록을 재시도한다.</summary>
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

        if (changed.IsCompleted)
            logger.LogInformation("연결 설정이 바뀌었습니다");
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

        connection.On<RunCommandRequest>(nameof(IAgentClient.RunCommand), request =>
        {
            logger.LogInformation("명령 수신 {RunId}: {CommandLine}", request.RunId, request.CommandLine);
            runner.Start(request);
        });
        connection.On<string>(nameof(IAgentClient.CancelCommand), runner.Cancel);
        connection.On<CollectFilesRequest>(nameof(IAgentClient.CollectFiles), files.StartCollect);
        connection.On<UploadFileRequest>(nameof(IAgentClient.UploadFile), files.StartUpload);
        connection.On<DownloadFileRequest>(nameof(IAgentClient.DownloadFile), files.StartDownload);
        // 응답을 기다리는 호출: 수신 루프를 막지 않도록 스레드 풀에서 처리
        connection.On<string?, DirectoryListing>(AgentClientMethods.ListDirectory,
            path => Task.Run(() => files.ListDirectory(path)));
        connection.On<string, long>(AgentClientMethods.GetFileSize,
            path => Task.Run(() => files.GetFileSize(path)));
        connection.On<string, long, int, byte[]>(AgentClientMethods.ReadFileChunk,
            (path, offset, length) => Task.Run(() => files.ReadFileChunk(path, offset, length)));

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

        // 런처의 업데이트 알림용 (서버가 업그레이드되면 재접속하면서 다시 확인된다)
        var (version, _) = await ServerInfoClient.ProbeAsync(settings.ServerUrl, ct);
        if (version is not null)
            status.SetServerVersion(version);
    }

    private async Task PumpOutboundAsync(CancellationToken ct)
    {
        var reader = outbound.Reader;
        var batch = new List<CommandOutput>(MaxOutputBatch);

        while (await reader.WaitToReadAsync(ct))
        {
            // 연속된 출력 줄은 한 번에 묶고, 시작/종료 보고를 만나면 출력부터 보낸다
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
                case null when batch.Count > 0:
                    // 출력이 쏟아질 때 조금 모아서 보낸다
                    await Task.Delay(100, ct);
                    break;
            }
        }
    }

    /// <summary>등록된 연결이 생길 때까지 기다렸다가 전달이 확인될 때까지 재시도한다.</summary>
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
