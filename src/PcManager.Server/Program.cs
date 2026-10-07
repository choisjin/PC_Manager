using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Hosting.WindowsServices;
using PcManager.Server;
using PcManager.Server.Api;
using PcManager.Server.Data;
using PcManager.Server.Hubs;
using PcManager.Server.Services;
using PcManager.Shared;

// 포터블 실행: PcManager.Server.exe --port 5070 [--data D:\pcm-data] [--https-port 5071 --cert D:\...\server.pfx]
// 프로젝트별 포털이 자식 프로세스로 띄우는 용도. 설치형 설정(server.json)을 읽지 않으므로
// 같은 PC의 설치형 서버나 다른 프로젝트 인스턴스와 포트·데이터가 겹치지 않는다
var portablePort = ServerArgs.Port(args);
var portable = portablePort is not null;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    // 서비스로 실행되면 작업 폴더가 System32라서 실행 파일 폴더를 기준으로 삼는다 (포터블도 호출한 쪽 작업 폴더와 무관하게)
    ContentRootPath = WindowsServiceHelpers.IsWindowsService() || portable ? AppContext.BaseDirectory : null,
});
builder.Services.AddWindowsService(o => o.ServiceName = "PcManagerServer");

if (portable)
{
    // 런처가 출력을 받아 로그 파일로 남긴다 (기본 OEM 코드 페이지면 한글이 깨짐)
    try { Console.OutputEncoding = Encoding.UTF8; } catch (IOException) { }
    if (ServerArgs.Value(args, "--data") is { Length: > 0 } dataDir)
        builder.Configuration["Server:DataDirectory"] = dataDir;

    // HTTPS(선택): 런처가 만든 자체 서명 인증서(pfx). 원격조작 키보드 잠금·WebCodecs는 HTTPS에서만 된다.
    // 같은 이름의 .cer(공개 인증서)를 에이전트·대시보드 PC가 받아 신뢰한다
    var httpsPort = ServerArgs.Port(args, "--https-port");
    if (httpsPort is not null && ServerArgs.Value(args, "--cert") is { Length: > 0 } certFile)
    {
        var certificate = X509CertificateLoader.LoadPkcs12FromFile(certFile, password: null);
        builder.WebHost.ConfigureKestrel(kestrel =>
        {
            kestrel.ListenAnyIP(portablePort!.Value);
            kestrel.ListenAnyIP(httpsPort.Value, listen => listen.UseHttps(certificate));
        });
        builder.Configuration["Server:PortableHttpsPort"] = httpsPort.Value.ToString();
        builder.Configuration["Server:PortableHttpPort"] = portablePort!.Value.ToString();
        builder.Configuration["Server:CertificateFile"] = Path.ChangeExtension(certFile, ".cer");
    }
    else
    {
        builder.WebHost.UseUrls($"http://*:{portablePort}");
    }
}
else
{
    // 설치형 배포: 설치 스크립트가 만든 설정 파일 (바이너리와 분리돼 업그레이드해도 유지)
    builder.Configuration.AddJsonFile(ServerOptions.InstalledConfigPath, optional: true, reloadOnChange: false);
}

var serverOptions = builder.Configuration.GetSection("Server").Get<ServerOptions>() ?? new ServerOptions();
serverOptions.Portable = portable;
builder.Services.Configure<ServerOptions>(builder.Configuration.GetSection("Server"));
builder.Services.PostConfigure<ServerOptions>(o => o.Portable = portable);

var paths = new AppPaths(Path.GetFullPath(serverOptions.DataDirectory, builder.Environment.ContentRootPath));
Directory.CreateDirectory(paths.DataDirectory);

builder.Services.AddSingleton(paths);
builder.Services.AddDbContextFactory<AppDbContext>(o =>
    o.UseSqlite($"Data Source={Path.Combine(paths.DataDirectory, "pcmanager.db")}"));
// 미디어 스트리밍 조각(256KB, base64)이 여유 있게 들어가도록 넉넉히 잡는다
builder.Services.AddSignalR(o => o.MaximumReceiveMessageSize = 2 * 1024 * 1024);
builder.Services.AddSingleton<AgentRegistry>();
builder.Services.AddSingleton<MediaStreamBroker>();
builder.Services.AddSingleton<RunLogStore>();
builder.Services.AddSingleton<PcGroupStore>();
builder.Services.AddSingleton<PcFavoriteStore>();
builder.Services.AddSingleton<SharedFolderStore>();
builder.Services.AddSingleton<LocalShareFiles>();
builder.Services.AddSingleton<OrgStore>();
builder.Services.AddSingleton<PresenceRegistry>();
builder.Services.AddSingleton<DownloadLinkStore>();
builder.Services.AddSingleton<PcStatusStore>();
builder.Services.AddSingleton<RemoteUsageRegistry>();
builder.Services.AddSingleton<ChatRoomStore>();
builder.Services.AddSingleton<NoteStore>();
builder.Services.AddSingleton<PcLockStore>();
builder.Services.AddHostedService<NoteImageJanitor>();
builder.Services.AddSingleton<ResultSetStore>();
builder.Services.AddSingleton<ThumbnailService>();
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton<RunService>();
builder.Services.AddSingleton<ArtifactStore>();
builder.Services.AddSingleton<CompletionNotifier>();
builder.Services.AddSingleton<TransferService>();
builder.Services.AddSingleton<JobService>();
builder.Services.AddSingleton<UpdateService>();
builder.Services.AddHostedService<UpdateRefresher>();
builder.Services.AddHostedService<AgentAutoUpdater>();

var app = builder.Build();

// TODO: 스키마가 안정되면 EF 마이그레이션으로 전환
await using (var db = await app.Services.GetRequiredService<IDbContextFactory<AppDbContext>>().CreateDbContextAsync())
{
    await db.Database.EnsureCreatedAsync();
    // EnsureCreated는 기존 DB에 새 컬럼을 추가하지 않으므로, 없으면 안전하게 추가한다.
    try
    {
        await db.Database.ExecuteSqlRawAsync("ALTER TABLE Transfers ADD COLUMN StartedByUserId TEXT");
    }
    catch (Microsoft.Data.Sqlite.SqliteException)
    {
        // 이미 컬럼이 있으면 무시
    }
}
// HTTPS 자체 서명 인증서를 이 PC의 신뢰 저장소에 넣는다 (서비스 = LocalSystem 권한). 서버 PC에서 대시보드를 열 때 경고 방지
if (WindowsServiceHelpers.IsWindowsService()
    && builder.Configuration["Kestrel:Endpoints:Https:Certificate:Subject"] is { Length: > 0 } certSubject)
{
    try
    {
        using var cert = CertificateTrust.FindServerCertificate(certSubject);
        if (cert is not null && CertificateTrust.EnsureTrustedRoot(cert))
            app.Logger.LogInformation("HTTPS 인증서를 신뢰 저장소에 추가했습니다 ({Thumbprint})", cert.Thumbprint);
    }
    catch (Exception ex) when (ex is System.Security.Cryptography.CryptographicException or UnauthorizedAccessException)
    {
        app.Logger.LogWarning("HTTPS 인증서 신뢰 설정 실패: {Message}", ex.Message);
    }
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
// 원격조작 화면 중계 (브라우저 ↔ 서버 ↔ 에이전트)
// KeepAliveTimeout: ping에 30초 동안 응답이 없으면 끊는다 (탭 강제 종료·네트워크 끊김으로 '원격 사용 중'이 남지 않게)
// PIN으로 잠긴 PC: 잠금 해제 쿠키가 없으면 파일·원격조작 등 PC 내용에 닿는 API를 막는다
app.UsePcLocks();

app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(15), KeepAliveTimeout = TimeSpan.FromSeconds(30) });

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapHub<AgentHub>(HubPaths.Agent);
app.MapHub<DashboardHub>(HubPaths.Dashboard);
app.MapApi();
app.MapFileApi();
app.MapTextApi();
app.MapChatApi();
app.MapNoteApi();
app.MapPcLockApi();
app.MapFileIconApi();
app.MapMediaApi();
app.MapRemoteApi();
app.MapPcStatusApi();
app.MapJobApi();
app.MapUpdateApi();
app.MapPcGroupApi();
app.MapPcFavoriteApi();
app.MapSharedFolderApi();
app.MapOrgApi();
app.MapDownloadLinkApi();
app.MapInstallApi(serverOptions);
app.MapLauncherApi();
app.MapResultSetApi();

// 설치 파일은 크므로 요청 크기 제한과 무관하게 스트리밍 (다운로드만, 업로드 아님)

// 대시보드 화면 경로는 index.html로 (API 처리기는 모두 Api 네임스페이스: 난독화에서 매개변수 이름을 지키기 위함)
app.MapSpaFallback();

app.Run();
