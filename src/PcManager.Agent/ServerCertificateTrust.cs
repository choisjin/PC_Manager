using System.Security.Cryptography.X509Certificates;
using PcManager.Shared;

namespace PcManager.Agent;

/// <summary>
/// 서버의 HTTPS 인증서를 받아 이 PC의 신뢰 저장소에 넣는다.
/// 이 PC에서 대시보드를 HTTPS로 열어도 경고가 뜨지 않게 하기 위한 것. SYSTEM 서비스로 실행될 때만 동작한다.
/// 서버에 등록될 때와, 연결돼 있는 동안 10분마다 확인한다 (서버가 IP 변경 등으로 인증서를 재시작 없이 바꿔도 따라가게,
/// 누가 신뢰 저장소에서 지워도 다시 넣게)
/// </summary>
public class ServerCertificateTrust(AgentSettingsStore settingsStore, ILogger<ServerCertificateTrust> logger) : BackgroundService
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(10) };
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(10);

    private readonly SemaphoreSlim _gate = new(1, 1);
    // 같은 실패를 10분마다 반복해 남기지 않도록 마지막 경고를 기억한다
    private string? _lastWarning;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            while (true)
            {
                await Task.Delay(Interval, stoppingToken);
                var settings = settingsStore.Current;
                if (settings.HasServer && settings.Enabled)
                    await EnsureAsync(settings.ServerUrl, stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // 종료
        }
    }

    public async Task EnsureAsync(string serverUrl, CancellationToken ct)
    {
        if (!AgentHost.IsRunningAsService)
            return; // 개발용 콘솔 실행은 관리자 권한이 아닐 수 있다

        await _gate.WaitAsync(ct);
        try
        {
            using var response = await Http.GetAsync($"{serverUrl.TrimEnd('/')}/api/install/{InstallPaths.ServerCertificateFile}", ct);
            if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
                return; // HTTPS를 쓰지 않는 서버(개발 서버 등)
            response.EnsureSuccessStatusCode();

            using var certificate = X509CertificateLoader.LoadCertificate(await response.Content.ReadAsByteArrayAsync(ct));
            // 이미 신뢰 저장소에 있으면 아무것도 하지 않는다
            if (CertificateTrust.EnsureTrustedRoot(certificate))
                logger.LogInformation("서버 HTTPS 인증서를 신뢰 저장소에 추가했습니다 ({Thumbprint})", certificate.Thumbprint);
            _lastWarning = null;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or System.Security.Cryptography.CryptographicException or UnauthorizedAccessException)
        {
            if (ct.IsCancellationRequested)
                return;
            if (ex.Message != _lastWarning)
                logger.LogWarning("서버 HTTPS 인증서 신뢰 설정 실패: {Message}", ex.Message);
            _lastWarning = ex.Message;
        }
        finally
        {
            _gate.Release();
        }
    }
}
