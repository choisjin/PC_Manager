using PcManager.Agent.Linux.Remote;

namespace PcManager.Agent.Linux;

/// <summary>에이전트 서비스 호스트. systemd 서비스(--service) 또는 시험용 콘솔(--console)</summary>
public static class LinuxAgentHost
{
    public const string ServiceName = "pcmanager-agent";

    /// <param name="serverOverride">--console --server로 준 주소 (설정 파일보다 우선, 저장하지 않음)</param>
    public static int Run(string? serverOverride)
    {
        var builder = Host.CreateApplicationBuilder(new HostApplicationBuilderSettings
        {
            Args = [],
            ContentRootPath = AppContext.BaseDirectory,
        });
        builder.Services.AddSystemd();

        builder.Configuration.AddJsonFile(AgentOptions.InstalledConfigPath, optional: true, reloadOnChange: false);
        if (serverOverride is not null)
            builder.Configuration.AddInMemoryCollection([new("Agent:ServerUrl", serverOverride)]);
        builder.Services.Configure<AgentOptions>(builder.Configuration.GetSection("Agent"));

        builder.Services.AddSingleton<AgentSettingsStore>();
        builder.Services.AddSingleton<AgentStatusTracker>();
        builder.Services.AddSingleton<AgentIdentity>();
        builder.Services.AddSingleton<OutboundQueue>();
        builder.Services.AddSingleton<CommandRunner>();
        builder.Services.AddSingleton<FileTransferService>();
        builder.Services.AddSingleton<VideoTrimmer>();
        builder.Services.AddSingleton<VideoImageSearch>();
        builder.Services.AddSingleton<VideoAnalyzer>();
        builder.Services.AddSingleton<SystemMonitor>();
        builder.Services.AddSingleton<LinuxRemoteControl>();
        builder.Services.AddSingleton<LinuxAgentUpdater>();
        builder.Services.AddHostedService<LinuxAgentWorker>();
        builder.Services.AddHostedService<LinuxLocalControlServer>();

        var host = builder.Build();
        var installLogger = host.Services.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(SystemdInstaller));
        SystemdInstaller.RepairUnit(installLogger);
        if (Environment.IsPrivilegedProcess && Environment.ProcessPath == SystemdInstaller.InstalledExe)
        {
            // 런처 창 바로 가기·자동 실행을 맞추고, 로그인한 사용자가 있으면 창을 띄운다 (설치·업데이트 직후).
            // 소켓 서버가 뜬 뒤에 띄우도록 잠시 기다린다
            DesktopIntegration.EnsureFiles(installLogger);
            _ = Task.Run(async () =>
            {
                await Task.Delay(TimeSpan.FromSeconds(3));
                DesktopIntegration.StartLauncherForSessionUser(installLogger);
            });
        }
        host.Run();
        return 0;
    }
}
