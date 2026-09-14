using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;

namespace PcManager.Agent;

/// <summary>
/// 런처 요청을 받는 named pipe 서버. 로그인한 모든 사용자가 연결/끊기/업데이트를 할 수 있다.
/// </summary>
public class LocalControlServer(
    AgentSettingsStore settings,
    AgentStatusTracker status,
    AgentUpdater updater,
    IHostApplicationLifetime lifetime,
    ILogger<LocalControlServer> logger) : BackgroundService
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            NamedPipeServerStream pipe;
            try
            {
                pipe = CreatePipe();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // 같은 이름의 파이프를 다른 프로세스가 쓰고 있음 (예: 개발용 콘솔과 서비스 동시 실행)
                logger.LogWarning("런처 통신 파이프를 만들 수 없습니다: {Message}", ex.Message);
                await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
                continue;
            }

            try
            {
                await pipe.WaitForConnectionAsync(stoppingToken);
            }
            catch (OperationCanceledException)
            {
                await pipe.DisposeAsync();
                break;
            }
            catch (IOException ex)
            {
                logger.LogDebug(ex, "런처 연결 대기 실패");
                await pipe.DisposeAsync();
                continue;
            }

            _ = HandleAsync(pipe, stoppingToken);
        }
    }

    private static NamedPipeServerStream CreatePipe()
    {
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        // 개발용 콘솔 실행 시 현재 사용자
        security.AddAccessRule(new PipeAccessRule(
            WindowsIdentity.GetCurrent().User!, PipeAccessRights.FullControl, AccessControlType.Allow));

        return NamedPipeServerStreamAcl.Create(
            LocalControl.PipeName, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 0, 0, security);
    }

    private async Task HandleAsync(NamedPipeServerStream pipe, CancellationToken stoppingToken)
    {
        await using (pipe)
        {
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                timeout.CancelAfter(RequestTimeout);
                using var reader = new StreamReader(pipe, leaveOpen: true);
                await using var writer = new StreamWriter(pipe, leaveOpen: true) { AutoFlush = true };

                var line = await reader.ReadLineAsync(timeout.Token);
                var request = line is null ? null : JsonSerializer.Deserialize<LocalRequest>(line, Json);
                var response = request is null
                    ? Fail("잘못된 요청입니다.")
                    : await ProcessAsync(request, timeout.Token);
                await writer.WriteLineAsync(JsonSerializer.Serialize(response, Json));
            }
            catch (Exception ex) when (ex is IOException or OperationCanceledException or JsonException)
            {
                logger.LogDebug(ex, "런처 요청 처리 중단");
            }
        }
    }

    private async Task<LocalResponse> ProcessAsync(LocalRequest request, CancellationToken ct)
    {
        switch (request.Command)
        {
            case LocalControl.StatusCommand:
                return Ok();

            case LocalControl.ConnectCommand:
            {
                var serverUrl = ServerInfoClient.NormalizeServerUrl(request.ServerUrl);
                if (serverUrl is null)
                    return Fail("서버 주소 형식이 올바르지 않습니다. 예: 192.168.0.10:5063");

                var (version, error) = await ServerInfoClient.ProbeAsync(serverUrl, ct);
                if (error is not null)
                    return Fail($"서버에 연결할 수 없습니다: {error}");

                status.SetServerVersion(version);
                settings.Save(settings.Current with { ServerUrl = serverUrl, Enabled = true });
                logger.LogInformation("런처에서 서버 연결: {ServerUrl}", serverUrl);
                return Ok();
            }

            case LocalControl.DisconnectCommand:
                settings.Save(settings.Current with { Enabled = false });
                logger.LogInformation("런처에서 연결 끊기");
                return Ok();

            case LocalControl.UpdateCommand:
                if (!settings.Current.HasServer)
                    return Fail("서버에 연결된 뒤 업데이트할 수 있습니다.");
                updater.Start(null);
                status.SetUpdating(true);
                logger.LogInformation("런처에서 업데이트 시작");
                return Ok();

            case LocalControl.StopCommand:
                logger.LogInformation("런처에서 에이전트 종료 요청");
                // 응답이 런처에 전달된 뒤 서비스를 멈춘다
                _ = Task.Run(async () =>
                {
                    await Task.Delay(500);
                    lifetime.StopApplication();
                });
                return Ok();

            default:
                return Fail($"알 수 없는 명령입니다: {request.Command}");
        }
    }

    private LocalResponse Ok() => new(true, null, status.Snapshot(settings.Current));

    private LocalResponse Fail(string error) => new(false, error, status.Snapshot(settings.Current));
}
