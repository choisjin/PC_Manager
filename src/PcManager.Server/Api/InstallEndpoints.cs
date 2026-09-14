using System.Security.Cryptography;
using System.Text;

namespace PcManager.Server.Api;

/// <param name="InstallCommand">테스트 PC의 관리자 PowerShell에서 실행할 한 줄 설치 명령. 패키지가 없으면 null</param>
public record InstallInfo(string ServerUrl, string ServerVersion, bool AgentPackageAvailable, string? InstallCommand);

/// <summary>
/// 에이전트 원격 설치 지원. 서버 패키지의 agent 폴더에 에이전트 zip과 설치 스크립트가 들어 있다.
/// </summary>
public static class InstallEndpoints
{
    public const string PackageFolder = "agent";
    public const string AgentPackageFile = "PcManager-Agent.zip";
    public const string AgentInstallScriptFile = "install-agent.ps1";

    public static void MapInstallApi(this WebApplication app, ServerOptions options)
    {
        var packageDirectory = Path.Combine(app.Environment.ContentRootPath, PackageFolder);
        var packagePath = Path.Combine(packageDirectory, AgentPackageFile);
        var scriptPath = Path.Combine(packageDirectory, AgentInstallScriptFile);
        var expectedToken = Encoding.UTF8.GetBytes(options.AgentToken);
        var version = typeof(InstallEndpoints).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";

        bool IsValidToken(string? token) =>
            token is not null && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(token), expectedToken);

        string GetServerUrl(HttpRequest request) =>
            (string.IsNullOrWhiteSpace(options.PublicUrl) ? $"{request.Scheme}://{request.Host}" : options.PublicUrl).TrimEnd('/');

        static string Quote(string value) => "'" + value.Replace("'", "''") + "'";

        var api = app.MapGroup("/api/install");

        // 대시보드 '에이전트 추가' 화면용. 대시보드 인증(5단계) 전까지는 같은 망에서 누구나 조회할 수 있다
        api.MapGet("/info", (string? tags, HttpRequest request) =>
        {
            var serverUrl = GetServerUrl(request);
            var available = File.Exists(packagePath) && File.Exists(scriptPath);
            var query = $"token={Uri.EscapeDataString(options.AgentToken)}";
            if (!string.IsNullOrWhiteSpace(tags))
                query += $"&tags={Uri.EscapeDataString(tags)}";

            var command = available
                ? $"powershell -NoProfile -ExecutionPolicy Bypass -Command \"iex (irm '{serverUrl}/api/install/agent.ps1?{query}')\""
                : null;
            return new InstallInfo(serverUrl, version, available, command);
        });

        // 설치 스크립트에 서버 주소, 토큰, 태그를 채워서 돌려준다
        api.MapGet("/agent.ps1", (string? token, string? tags, HttpRequest request) =>
        {
            if (!IsValidToken(token))
                return Results.Unauthorized();
            if (!File.Exists(scriptPath))
                return Results.NotFound("서버 패키지에 에이전트 설치 스크립트가 없습니다.");

            var arguments = $"-ServerUrl {Quote(GetServerUrl(request))} -Token {Quote(options.AgentToken)}";
            var tagList = (tags ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (tagList.Length > 0)
                arguments += $" -Tags {string.Join(",", tagList.Select(Quote))}";

            var script = File.ReadAllText(scriptPath);
            return Results.Text($"& {{\n{script}\n}} {arguments}\n", "text/plain; charset=utf-8");
        });

        api.MapGet("/agent.zip", (string? token) =>
        {
            if (!IsValidToken(token))
                return Results.Unauthorized();
            return File.Exists(packagePath)
                ? Results.File(packagePath, "application/zip", AgentPackageFile)
                : Results.NotFound();
        });
    }
}
