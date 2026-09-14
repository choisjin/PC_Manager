using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting.WindowsServices;
using PcManager.Server;
using PcManager.Server.Api;
using PcManager.Server.Data;
using PcManager.Server.Hubs;
using PcManager.Server.Services;
using PcManager.Shared;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    // 서비스로 실행되면 작업 폴더가 System32라서 실행 파일 폴더를 기준으로 삼는다
    ContentRootPath = WindowsServiceHelpers.IsWindowsService() ? AppContext.BaseDirectory : null,
});
builder.Services.AddWindowsService(o => o.ServiceName = "PcManagerServer");

// 설치형 배포: 설치 스크립트가 만든 설정 파일 (바이너리와 분리돼 업그레이드해도 유지)
builder.Configuration.AddJsonFile(ServerOptions.InstalledConfigPath, optional: true, reloadOnChange: false);

var serverOptions = builder.Configuration.GetSection("Server").Get<ServerOptions>() ?? new ServerOptions();

var paths = new AppPaths(Path.GetFullPath(serverOptions.DataDirectory, builder.Environment.ContentRootPath));
Directory.CreateDirectory(paths.DataDirectory);

builder.Services.AddSingleton(paths);
builder.Services.AddDbContextFactory<AppDbContext>(o =>
    o.UseSqlite($"Data Source={Path.Combine(paths.DataDirectory, "pcmanager.db")}"));
builder.Services.AddSignalR(o => o.MaximumReceiveMessageSize = 1024 * 1024);
builder.Services.AddSingleton<AgentRegistry>();
builder.Services.AddSingleton<RunLogStore>();
builder.Services.AddSingleton<RunService>();
builder.Services.AddSingleton<ArtifactStore>();
builder.Services.AddSingleton<CompletionNotifier>();
builder.Services.AddSingleton<TransferService>();
builder.Services.AddSingleton<JobService>();

var app = builder.Build();

// TODO: 스키마가 안정되면 EF 마이그레이션으로 전환
await using (var db = await app.Services.GetRequiredService<IDbContextFactory<AppDbContext>>().CreateDbContextAsync())
{
    await db.Database.EnsureCreatedAsync();
}
await app.Services.GetRequiredService<JobService>().RecoverInterruptedAsync();

// 에이전트 토큰(선택): 설정하면 에이전트 Hub와 에이전트 전용 API는 토큰이 맞는 요청만 통과시킨다.
// 비워 두면 서버 주소만으로 에이전트가 연결된다 (신뢰할 수 있는 내부망 전제)
if (!string.IsNullOrWhiteSpace(serverOptions.AgentToken))
{
    var expectedToken = Encoding.UTF8.GetBytes(serverOptions.AgentToken);
    app.UseWhen(
        context => context.Request.Path.StartsWithSegments(HubPaths.Agent)
            || context.Request.Path.StartsWithSegments("/api/agent"),
        branch => branch.Use(async (context, next) =>
        {
            var provided = Encoding.UTF8.GetBytes(context.Request.Headers[AgentHeaders.Token].ToString());
            if (!CryptographicOperations.FixedTimeEquals(provided, expectedToken))
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }
            await next();
        }));
}

// 배포 패키지는 대시보드 빌드 결과를 wwwroot에 포함한다 (개발 중에는 Vite 개발 서버 사용)
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapHub<AgentHub>(HubPaths.Agent);
app.MapHub<DashboardHub>(HubPaths.Dashboard);
app.MapApi();
app.MapFileApi();
app.MapJobApi();
app.MapInstallApi(serverOptions);

// 설치 파일은 크므로 요청 크기 제한과 무관하게 스트리밍 (다운로드만, 업로드 아님)

// 대시보드 화면 경로는 index.html로 돌려준다. 없는 API/Hub 경로는 404
app.MapFallback("{*path:nonfile}", (HttpContext context, IWebHostEnvironment env) =>
{
    var indexPath = Path.Combine(env.WebRootPath ?? Path.Combine(env.ContentRootPath, "wwwroot"), "index.html");
    var isApi = context.Request.Path.StartsWithSegments("/api") || context.Request.Path.StartsWithSegments("/hubs");
    return isApi || !File.Exists(indexPath) ? Results.NotFound() : Results.File(indexPath, "text/html; charset=utf-8");
});

app.Run();
