using System.Diagnostics;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.Extensions.Hosting.Systemd;

namespace PcManager.Agent.Linux;

/// <summary>
/// 런처 창(--launcher, 로그인 사용자 권한) 요청을 받는 Unix 소켓 서버. Windows LocalControlServer와 같은 규약
/// (요청 1줄 → 응답 1줄 JSON). 로그인한 누구나 연결/끊기/업데이트를 할 수 있다 (Windows와 같음)
/// </summary>
public class LinuxLocalControlServer(
    AgentSettingsStore settings,
    AgentStatusTracker status,
    LinuxAgentUpdater updater,
    IHostApplicationLifetime lifetime,
    ILogger<LinuxLocalControlServer> logger) : BackgroundService
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var path = LocalControl.UnixSocketPath;
        Socket listener;
        try
        {
            var directory = Path.GetDirectoryName(path)!;
            Directory.CreateDirectory(directory);
            File.SetUnixFileMode(directory, (UnixFileMode)0b111_101_101);
            if (File.Exists(path))
                File.Delete(path); // 지난 실행이 남긴 소켓 파일
            listener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            listener.Bind(new UnixDomainSocketEndPoint(path));
            File.SetUnixFileMode(path, (UnixFileMode)0b110_110_110);
            listener.Listen(16);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or SocketException)
        {
            // 개발용 콘솔(root 아님) 실행 등: 런처 창만 못 쓴다
            logger.LogWarning("런처 통신 소켓을 만들 수 없습니다 ({Path}): {Message}", path, ex.Message);
            return;
        }

        using (listener)
        {
            try
            {
                while (!stoppingToken.IsCancellationRequested)
                {
                    var client = await listener.AcceptAsync(stoppingToken);
                    _ = HandleAsync(client, stoppingToken);
                }
            }
            catch (OperationCanceledException)
            {
                // 종료
            }
            finally
            {
                try
                {
                    File.Delete(path);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                }
            }
        }
    }

    private async Task HandleAsync(Socket client, CancellationToken stoppingToken)
    {
        using (client)
        await using (var stream = new NetworkStream(client, ownsSocket: false))
        {
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                timeout.CancelAfter(RequestTimeout);
                using var reader = new StreamReader(stream, leaveOpen: true);
                await using var writer = new StreamWriter(stream, leaveOpen: true) { AutoFlush = true };

                var line = await reader.ReadLineAsync(timeout.Token);
                var request = line is null ? null : JsonSerializer.Deserialize<LocalRequest>(line, Json);
                var response = request is null
                    ? Fail("잘못된 요청입니다.")
                    : await ProcessAsync(request, timeout.Token);
                await writer.WriteLineAsync(JsonSerializer.Serialize(response, Json));
            }
            catch (Exception ex) when (ex is IOException or OperationCanceledException or JsonException or SocketException)
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

                var (version, dashboardUrl, error) = await ServerInfoClient.ProbeAsync(serverUrl, ct);
                if (error is not null)
                    return Fail($"서버에 연결할 수 없습니다: {error}");

                status.SetServerInfo(version, dashboardUrl);
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
                updater.Start();
                logger.LogInformation("런처에서 업데이트 시작");
                return Ok();

            case LocalControl.StopCommand:
                logger.LogInformation("런처에서 에이전트 종료 요청");
                // 응답이 런처에 전달된 뒤 멈춘다. systemd 서비스는 Restart=always라 프로세스만 끝내면 다시 뜨므로
                // systemctl로 서비스를 멈춘다 (다음 부팅 때는 다시 시작)
                _ = Task.Run(async () =>
                {
                    await Task.Delay(500);
                    if (SystemdHelpers.IsSystemdService())
                    {
                        try
                        {
                            Process.Start("systemctl", ["stop", "--no-block", LinuxAgentHost.ServiceName])?.Dispose();
                            return;
                        }
                        catch (System.ComponentModel.Win32Exception ex)
                        {
                            logger.LogWarning("systemctl stop 실패: {Message}", ex.Message);
                        }
                    }
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
