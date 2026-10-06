using System.Security.Cryptography;
using System.Text;

namespace PcManager.Server.Api;

/// <summary>
/// 서버 런처(PcManager.ServerLauncher)가 자식으로 띄운 서버를 정상 종료시키는 경로.
/// 런처가 실행할 때마다 만든 토큰을 환경변수로 넘기며, 토큰이 없으면(런처가 띄운 서버가 아니면) 경로 자체를 만들지 않는다.
/// </summary>
public static class LauncherEndpoints
{
    public const string TokenVariable = "PCM_LAUNCHER_TOKEN";
    public const string TokenHeader = "X-Launcher-Token";

    public static void MapLauncherApi(this WebApplication app)
    {
        var token = Environment.GetEnvironmentVariable(TokenVariable);
        if (string.IsNullOrEmpty(token))
            return;
        var expected = Encoding.UTF8.GetBytes(token);

        app.MapPost("/api/launcher/shutdown", (HttpContext context, IHostApplicationLifetime lifetime) =>
        {
            var remote = context.Connection.RemoteIpAddress;
            var provided = Encoding.UTF8.GetBytes(context.Request.Headers[TokenHeader].ToString());
            if (remote is null || !System.Net.IPAddress.IsLoopback(remote) || !CryptographicOperations.FixedTimeEquals(provided, expected))
                return Results.NotFound();
            lifetime.StopApplication();
            return Results.Accepted();
        });
    }
}
