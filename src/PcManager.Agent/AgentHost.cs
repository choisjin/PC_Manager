using Microsoft.Extensions.Hosting.WindowsServices;
using PcManager.Agent.Service;

namespace PcManager.Agent;

/// <summary>에이전트 서비스 호스트. Windows 서비스 또는 개발용 콘솔(--console)로 실행한다.</summary>
public static class AgentHost
{
    public const string ServiceName = "PcManagerAgent";

    public static int Run()
    {
        var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings
        {
            // 실행 모드 인자(--console 등)는 설정 값이 아니므로 넘기지 않는다
            Args = [],
            // 서비스로 실행되면 작업 폴더가 System32라서 실행 파일 폴더를 기준으로 삼는다
            ContentRootPath = AppContext.BaseDirectory,
        });
        builder.Services.AddWindowsService(o => o.ServiceName = ServiceName);

        // 런처/설치 도구가 저장한 연결 설정. 업그레이드해도 유지된다
        builder.Configuration.AddJsonFile(AgentOptions.InstalledConfigPath, optional: true, reloadOnChange: false);
        builder.Services.Configure<AgentOptions>(builder.Configuration.GetSection("Agent"));

        builder.Services.AddSingleton<AgentSettingsStore>();
        builder.Services.AddSingleton<AgentStatusTracker>();
        builder.Services.AddSingleton<AgentUpdater>();
        builder.Services.AddSingleton<AgentIdentity>();
        builder.Services.AddSingleton<OutboundQueue>();
        builder.Services.AddSingleton<CommandRunner>();
        builder.Services.AddSingleton<FileTransferService>();
        builder.Services.AddHostedService<AgentWorker>();
        builder.Services.AddHostedService<LocalControlServer>();
        builder.Services.AddHostedService<LauncherSupervisor>();

        builder.Build().Run();
        return 0;
    }

    public static bool IsRunningAsService => WindowsServiceHelpers.IsWindowsService();
}
