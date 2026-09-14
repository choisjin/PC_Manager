using PcManager.Shared;

namespace PcManager.Server.Api;

/// <param name="ServerUrl">테스트 PC의 런처에 입력할 서버 주소</param>
/// <param name="SetupAvailable">서버에 에이전트 설치 파일이 있으면 true</param>
/// <param name="SetupDownloadUrl">더블클릭 설치 파일 다운로드 경로</param>
public record InstallInfo(string ServerUrl, string ServerVersion, bool SetupAvailable, string SetupDownloadUrl);

/// <summary>
/// 에이전트 설치 지원. 서버 패키지의 agent 폴더에 더블클릭 설치 파일(PcManager-Agent-Setup.exe)이 들어 있다.
/// 대시보드 'PC 추가'에서 이 파일을 내려받아 테스트 PC에서 더블클릭하면 서비스와 런처가 설치된다.
/// </summary>
public static class InstallEndpoints
{
    public const string PackageFolder = "agent";
    public static string SetupFileName => InstallPaths.AgentSetupFile;

    public static void MapInstallApi(this WebApplication app, ServerOptions options)
    {
        var setupPath = Path.Combine(app.Environment.ContentRootPath, PackageFolder, SetupFileName);
        var version = typeof(InstallEndpoints).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

        string ServerUrl(HttpRequest request) =>
            (string.IsNullOrWhiteSpace(options.PublicUrl) ? $"{request.Scheme}://{request.Host}" : options.PublicUrl).TrimEnd('/');

        var api = app.MapGroup("/api/install");

        api.MapGet("/info", (HttpRequest request) =>
            new InstallInfo(ServerUrl(request), version, File.Exists(setupPath), $"/api/install/{SetupFileName}"));

        api.MapGet($"/{SetupFileName}", () =>
            File.Exists(setupPath)
                ? Results.File(setupPath, "application/octet-stream", SetupFileName)
                : Results.NotFound());
    }
}
