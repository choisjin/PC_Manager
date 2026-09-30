using System.Security.Cryptography.X509Certificates;
using PcManager.Shared;

namespace PcManager.Agent;

/// <summary>
/// 서버에 등록될 때 서버의 HTTPS 인증서를 받아 이 PC의 신뢰 저장소에 넣는다.
/// 이 PC에서 대시보드를 HTTPS로 열어도 경고가 뜨지 않게 하기 위한 것. SYSTEM 서비스로 실행될 때만 동작한다.
/// </summary>
public class ServerCertificateTrust(ILogger<ServerCertificateTrust> logger)
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(10) };

    // 같은 서버에 재접속할 때마다 반복하지 않도록 마지막으로 처리한 지문을 기억한다
    private string? _lastThumbprint;

    public async Task EnsureAsync(string serverUrl, CancellationToken ct)
    {
        if (!AgentHost.IsRunningAsService)
            return; // 개발용 콘솔 실행은 관리자 권한이 아닐 수 있다

        try
        {
            using var response = await Http.GetAsync($"{serverUrl.TrimEnd('/')}/api/install/{InstallPaths.ServerCertificateFile}", ct);
            if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
                return; // HTTPS를 쓰지 않는 서버(개발 서버 등)
            response.EnsureSuccessStatusCode();

            using var certificate = X509CertificateLoader.LoadCertificate(await response.Content.ReadAsByteArrayAsync(ct));
            if (certificate.Thumbprint == _lastThumbprint)
                return;
            _lastThumbprint = certificate.Thumbprint;

            if (CertificateTrust.EnsureTrustedRoot(certificate))
                logger.LogInformation("서버 HTTPS 인증서를 신뢰 저장소에 추가했습니다 ({Thumbprint})", certificate.Thumbprint);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or System.Security.Cryptography.CryptographicException or UnauthorizedAccessException)
        {
            logger.LogWarning("서버 HTTPS 인증서 신뢰 설정 실패: {Message}", ex.Message);
        }
    }
}
