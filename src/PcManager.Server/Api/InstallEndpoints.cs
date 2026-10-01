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
    string? ServerMachineName = null);

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
    private static string CertificatePath => Path.Combine(Path.GetDirectoryName(ServerOptions.InstalledConfigPath)!, CertificateFileName);

    public static void MapInstallApi(this WebApplication app, ServerOptions options)
    {
        var setupPath = Path.Combine(app.Environment.ContentRootPath, PackageFolder, SetupFileName);
        var version = typeof(InstallEndpoints).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

        string ServerUrl(HttpRequest request) =>
            (string.IsNullOrWhiteSpace(options.PublicUrl) ? $"{request.Scheme}://{request.Host}" : options.PublicUrl).TrimEnd('/');

        var api = app.MapGroup("/api/install");

        api.MapGet("/info", (HttpRequest request) =>
            new InstallInfo(ServerUrl(request), version, File.Exists(setupPath), $"/api/install/{SetupFileName}",
                string.IsNullOrWhiteSpace(options.DashboardHttpsUrl) ? null : options.DashboardHttpsUrl.TrimEnd('/'),
                File.Exists(CertificatePath) ? $"/api/install/{CertificateFileName}" : null,
                File.Exists(CertificatePath) ? $"/api/install/{CertificateInstallerName}" : null,
                Environment.MachineName));

        api.MapGet($"/{CertificateFileName}", () =>
            File.Exists(CertificatePath)
                ? Results.File(CertificatePath, "application/x-x509-ca-cert", CertificateFileName)
                : Results.NotFound());

        // 에이전트가 없는 PC(관리자 워크스테이션)용: 더블클릭 → UAC 승인 → 서버 인증서를 신뢰 저장소에 설치
        api.MapGet($"/{CertificateInstallerName}", (HttpRequest request) =>
            File.Exists(CertificatePath)
                ? Results.File(
                    System.Text.Encoding.UTF8.GetBytes(BuildCertificateInstaller($"{ServerUrl(request)}/api/install/{CertificateFileName}")),
                    "application/octet-stream", CertificateInstallerName)
                : Results.NotFound());

        api.MapGet($"/{SetupFileName}", () =>
            File.Exists(setupPath)
                ? Results.File(setupPath, "application/octet-stream", SetupFileName)
                : Results.NotFound());
    }

    /// <summary>인증서를 내려받아 LocalMachine\Root에 넣는 배치 파일. 관리자가 아니면 스스로 승격한다</summary>
    private static string BuildCertificateInstaller(string certificateUrl)
    {
        // cmd는 ASCII + CRLF. 한글·따옴표는 피하고 PowerShell 한 줄로 실행한다 (cmd 코드 페이지·인용 문제 회피)
        var ps = string.Join("; ",
            "$ErrorActionPreference='Stop'",
            $"$u='{certificateUrl}'",
            "$p=Join-Path $env:TEMP 'PcManager-Server.cer'",
            "Invoke-WebRequest -Uri $u -OutFile $p -UseBasicParsing",
            "$c=New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($p)",
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
