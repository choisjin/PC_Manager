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
        builder.Services.AddSingleton<LinuxRemoteControl>();
        builder.Services.AddSingleton<LinuxAgentUpdater>();
        builder.Services.AddHostedService<LinuxAgentWorker>();

        var host = builder.Build();
        SystemdInstaller.RepairUnit(host.Services.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(SystemdInstaller)));
        host.Run();
        return 0;
    }
}
