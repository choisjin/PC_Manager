using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.Options;
using PcManager.Shared;

namespace PcManager.Agent.Service;

/// <summary>서버 연결 유지, 명령 수신, 보고 큐 전송을 담당한다.</summary>
public class AgentWorker(
    IOptions<AgentOptions> options,
    AgentIdentity identity,
    CommandRunner runner,
    FileTransferService files,
    OutboundQueue outbound,
    ILogger<AgentWorker> logger) : BackgroundService
{
    private const int MaxOutputBatch = 500;

    private volatile bool _registered;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var settings = options.Value;
        await using var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(new Uri(settings.ServerUrl), HubPaths.Agent),
                o => o.Headers[AgentHeaders.Token] = settings.Token)
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
        // 응답을 기다리는 호출: 수신 루프를 막지 않도록 스레드 풀에서 조회
        connection.On<string?, DirectoryListing>(AgentClientMethods.ListDirectory,
            path => Task.Run(() => files.ListDirectory(path)));

        connection.Reconnecting += error =>
        {
            _registered = false;
            logger.LogWarning("서버 연결 끊김, 재접속 중: {Message}", error?.Message);
            return Task.CompletedTask;
        };
        connection.Reconnected += async _ =>
        {
            try
            {
                await RegisterAsync(connection, stoppingToken);
            }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            {
                logger.LogWarning("재등록 실패: {Message}", ex.Message);
            }
        };
        connection.Closed += _ =>
        {
            _registered = false;
            return Task.CompletedTask;
        };

        var pump = PumpOutboundAsync(connection, stoppingToken);
        logger.LogInformation("에이전트 시작 (AgentId={AgentId}, Server={Server})", identity.AgentId, settings.ServerUrl);

        // 최초 접속과 등록 실패 시 재시도를 담당하는 감시 루프
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (connection.State == HubConnectionState.Disconnected)
                    await connection.StartAsync(stoppingToken);
                if (connection.State == HubConnectionState.Connected && !_registered)
                    await RegisterAsync(connection, stoppingToken);
            }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            {
                logger.LogWarning("서버 접속 실패: {Message}", ex.Message);
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
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

    private async Task RegisterAsync(HubConnection connection, CancellationToken ct)
    {
        string[] unreportedIds = [.. runner.UnreportedRunIds, .. files.UnreportedTransferIds];
        await connection.InvokeAsync(AgentHubMethods.Register, identity.CreateInfo(), unreportedIds, ct);
        _registered = true;
        logger.LogInformation("서버에 등록됨");
    }

    private async Task PumpOutboundAsync(HubConnection connection, CancellationToken ct)
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
                await SendAsync(connection, AgentHubMethods.ReportOutput, batch, ct);

            switch (message)
            {
                case CommandStarted started:
                    await SendAsync(connection, AgentHubMethods.ReportStarted, started, ct);
                    break;
                case CommandCompleted completed:
                    await SendAsync(connection, AgentHubMethods.ReportCompleted, completed, ct);
                    runner.MarkReported(completed.RunId);
                    break;
                case TransferCompleted transfer:
                    await SendAsync(connection, AgentHubMethods.ReportTransferCompleted, transfer, ct);
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
    private async Task SendAsync(HubConnection connection, string method, object payload, CancellationToken ct)
    {
        while (true)
        {
            while (!_registered || connection.State != HubConnectionState.Connected)
                await Task.Delay(500, ct);

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
