namespace PcManager.Agent.Linux;

/// <summary>
/// 서버가 업데이트를 요청하면 서버의 Linux 에이전트 파일(/api/install/pcmanager-agent-linux)로 실행 파일을 바꾸고
/// 프로세스를 끝낸다. systemd(Restart=always)가 새 파일로 다시 띄운다. 실행 중인 파일도 이름 바꾸기로 교체할 수 있다
/// </summary>
public class LinuxAgentUpdater(AgentSettingsStore settings, ILogger<LinuxAgentUpdater> logger, IHostApplicationLifetime lifetime)
{
    public const string DownloadPath = "/api/install/pcmanager-agent-linux";

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(10) };
    private int _running;

    public void Start()
    {
        if (Interlocked.Exchange(ref _running, 1) == 1)
            return;
        _ = Task.Run(RunAsync);
    }

    private async Task RunAsync()
    {
        try
        {
            var exe = Environment.ProcessPath!;
            if (!exe.StartsWith(SystemdInstaller.InstallDirectory + "/", StringComparison.Ordinal))
            {
                logger.LogWarning("설치된 서비스가 아니라 업데이트하지 않습니다 ({Path})", exe);
                return;
            }
            var url = settings.Current.ServerUrl.TrimEnd('/') + DownloadPath;
            logger.LogInformation("에이전트 업데이트 다운로드: {Url}", url);
            var temp = exe + ".new";
            await using (var source = await Http.GetStreamAsync(url))
            await using (var file = File.Create(temp))
                await source.CopyToAsync(file);
            File.SetUnixFileMode(temp, (UnixFileMode)0b111_101_101);
            File.Move(temp, exe, overwrite: true);
            logger.LogInformation("에이전트 파일을 바꿨습니다. 다시 시작합니다");
            // systemd가 새 파일로 다시 띄운다 (종료 코드 0이어도 Restart=always)
            lifetime.StopApplication();
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or UnauthorizedAccessException or TaskCanceledException)
        {
            logger.LogWarning("에이전트 업데이트 실패: {Message}", ex.Message);
        }
        finally
        {
            Interlocked.Exchange(ref _running, 0);
        }
    }
}
