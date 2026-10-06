using PcManager.Shared;

namespace PcManager.Server.Api;

/// <param name="ServerUrl">테스트 PC의 런처에 입력할 서버 주소</param>
/// <param name="SetupAvailable">서버에 에이전트 설치 파일이 있으면 true</param>
/// <param name="SetupDownloadUrl">더블클릭 설치 파일 다운로드 경로</param>
/// <param name="HttpsUrl">대시보드 HTTPS 주소 (원격조작 키보드 잠금·WebCodecs용). 설치형이 아니면 null</param>
/// <param name="CertificateDownloadUrl">자체 서명 인증서(.cer) 다운로드 경로. 없으면 null</param>
/// <param name="CertificateInstallerUrl">대시보드 PC용 인증서 신뢰 설치 도구(.cmd) 경로. 없으면 null</param>
public record InstallInfo(
    string ServerUrl, string ServerVersion, bool SetupAvailable, string SetupDownloadUrl,
    string? HttpsUrl = null, string? CertificateDownloadUrl = null, string? CertificateInstallerUrl = null,
    string? ServerMachineName = null,
    string? ClientIp = null);

/// <summary>
/// 에이전트 설치 지원. 서버 패키지의 agent 폴더에 더블클릭 설치 파일(PcManager-Agent-Setup.exe)이 들어 있다.
/// 대시보드 'PC 추가'에서 이 파일을 내려받아 테스트 PC에서 더블클릭하면 서비스와 런처가 설치된다.
/// </summary>
public static class InstallEndpoints
{
    public const string PackageFolder = "agent";
    public static string SetupFileName => InstallPaths.AgentSetupFile;

    /// <summary>설치 스크립트가 내보낸 공개 인증서. 대시보드 PC에서 신뢰 설치하면 HTTPS 경고가 사라진다</summary>
    public const string CertificateFileName = InstallPaths.ServerCertificateFile;
    public const string CertificateInstallerName = InstallPaths.CertificateInstallerFile;
    public static void MapInstallApi(this WebApplication app, ServerOptions options)
    {
        // 설치형: 설치 스크립트가 ProgramData에 내보낸 인증서 / 포터블: 런처가 만든 인증서
        var certificatePath = string.IsNullOrWhiteSpace(options.CertificateFile)
            ? Path.Combine(Path.GetDirectoryName(ServerOptions.InstalledConfigPath)!, CertificateFileName)
            : options.CertificateFile;

        string? HttpsUrl(HttpRequest request) =>
            !string.IsNullOrWhiteSpace(options.DashboardHttpsUrl) ? options.DashboardHttpsUrl.TrimEnd('/')
            : options.PortableHttpsPort > 0 ? $"https://{request.Host.Host}:{options.PortableHttpsPort}"
            : null;

        var setupPath = Path.Combine(app.Environment.ContentRootPath, PackageFolder, SetupFileName);
        var version = typeof(InstallEndpoints).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

        // 에이전트는 HTTPS 인증서를 등록한 뒤에야 신뢰하므로, 대시보드를 HTTPS로 열었어도 HTTP 주소를 알려준다
        string ServerUrl(HttpRequest request) =>
            (!string.IsNullOrWhiteSpace(options.PublicUrl) ? options.PublicUrl
            : request.IsHttps && options.PortableHttpPort > 0 ? $"http://{request.Host.Host}:{options.PortableHttpPort}"
            : $"{request.Scheme}://{request.Host}").TrimEnd('/');

        var api = app.MapGroup("/api/install");

        api.MapGet("/info", (HttpRequest request) =>
            new InstallInfo(ServerUrl(request), version, File.Exists(setupPath), $"/api/install/{SetupFileName}",
                HttpsUrl(request),
                File.Exists(certificatePath) ? $"/api/install/{CertificateFileName}" : null,
                File.Exists(certificatePath) ? $"/api/install/{CertificateInstallerName}" : null,
                Environment.MachineName,
                ClientIp(request)));

        api.MapGet($"/{CertificateFileName}", () =>
            File.Exists(certificatePath)
                ? Results.File(certificatePath, "application/x-x509-ca-cert", CertificateFileName)
                : Results.NotFound());

        // 에이전트가 없는 PC(관리자 워크스테이션)용: 더블클릭 → UAC 승인 → 서버 인증서를 신뢰 저장소에 설치
        api.MapGet($"/{CertificateInstallerName}", (HttpRequest request) =>
            File.Exists(certificatePath)
                ? Results.File(
                    System.Text.Encoding.UTF8.GetBytes(BuildCertificateInstaller(File.ReadAllBytes(certificatePath))),
                    "application/octet-stream", CertificateInstallerName)
                : Results.NotFound());

        api.MapGet($"/{SetupFileName}", () =>
            File.Exists(setupPath)
                ? Results.File(setupPath, "application/octet-stream", SetupFileName)
                : Results.NotFound());
    }

    /// <summary>대시보드를 연 PC의 IP (IPv4로 정규화). 이 PC의 에이전트를 Remote 화면에서 숨기는 데 쓴다. 서버 자신이면 null</summary>
    private static string? ClientIp(HttpRequest request)
    {
        var ip = request.HttpContext.Connection.RemoteIpAddress;
        if (ip is null || System.Net.IPAddress.IsLoopback(ip))
            return null;
        if (ip.IsIPv4MappedToIPv6)
            ip = ip.MapToIPv4();
        return ip.ToString();
    }

    /// <summary>
    /// 인증서를 LocalMachine\Root에 넣는 배치 파일. 관리자가 아니면 스스로 승격한다.
    /// 인증서를 파일 안에 넣어 둔다 — 서버 주소를 쓰면 프록시(NPMS 등)를 거쳐 받았을 때 127.0.0.1 같은 주소가 박혀 다른 PC에서 실패한다
    /// </summary>
    private static string BuildCertificateInstaller(byte[] certificate)
    {
        // cmd는 ASCII + CRLF. 한글·따옴표는 피하고 PowerShell 한 줄로 실행한다 (cmd 코드 페이지·인용 문제 회피)
        var ps = string.Join("; ",
            "$ErrorActionPreference='Stop'",
            $"$b=[Convert]::FromBase64String('{Convert.ToBase64String(certificate)}')",
            "$c=New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(,$b)",
            "$s=New-Object System.Security.Cryptography.X509Certificates.X509Store('Root','LocalMachine')",
            "$s.Open('ReadWrite')",
            "$s.Certificates | Where-Object { $_.Subject -eq $c.Subject -and $_.Thumbprint -ne $c.Thumbprint } | ForEach-Object { $s.Remove($_) }",
            "if (-not ($s.Certificates | Where-Object { $_.Thumbprint -eq $c.Thumbprint })) { $s.Add($c) }",
            "$s.Close()",
            "Write-Host ('PC Manager server certificate trusted: ' + $c.Subject) -ForegroundColor Green",
            "Write-Host 'Restart your browser, then open the HTTPS dashboard address.'",
            "Read-Host 'Press Enter to close'");
        return string.Join("\r\n",
            "@echo off",
            "rem PC Manager: trust the server HTTPS certificate on this PC (needs administrator, asks once)",
            "net session >nul 2>&1",
            "if %errorlevel% neq 0 (",
            "  powershell -NoProfile -Command \"Start-Process -FilePath '%~f0' -Verb RunAs\"",
            "  exit /b",
            ")",
            $"powershell -NoProfile -ExecutionPolicy Bypass -Command \"{ps}\"",
            "");
    }
}
