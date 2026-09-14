using System.Diagnostics;

namespace PcManager.Agent;

/// <summary>
/// 서버의 업데이트 명령을 받아 최신 설치 파일을 내려받고 자기 자신을 다시 설치한다.
/// 에이전트 서비스는 SYSTEM으로 실행되므로 설치기가 관리자 권한을 갖는다.
/// </summary>
public class AgentUpdater(
    AgentSettingsStore settings,
    AgentStatusTracker status,
    ILogger<AgentUpdater> logger)
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(10) };
    private int _started;

    /// <param name="setupUrl">설치 파일 URL. 비면 현재 서버 주소에서 받는다</param>
    public void Start(string? setupUrl)
    {
        // 중복 명령은 무시 (한 번 시작하면 곧 서비스가 교체된다)
        if (Interlocked.Exchange(ref _started, 1) == 1)
            return;

        _ = Task.Run(async () =>
        {
            try
            {
                await RunAsync(setupUrl);
            }
            catch (Exception ex)
            {
                Interlocked.Exchange(ref _started, 0);
                status.SetUpdating(false);
                logger.LogError(ex, "에이전트 자가 업데이트 실패");
            }
        });
    }

    private async Task RunAsync(string? setupUrl)
    {
        status.SetUpdating(true);

        var url = !string.IsNullOrWhiteSpace(setupUrl)
            ? setupUrl
            : new Uri(new Uri(settings.Current.ServerUrl), Shared.InstallPaths.AgentSetup).ToString();

        var tempDir = Path.Combine(Path.GetTempPath(), "PcManagerUpdate", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        var setupPath = Path.Combine(tempDir, Shared.InstallPaths.AgentSetupFile);

        logger.LogInformation("에이전트 업데이트 다운로드: {Url}", url);
        await using (var download = await Http.GetStreamAsync(url))
        await using (var file = new FileStream(setupPath, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            await download.CopyToAsync(file);
        }

        // 설치기를 독립 프로세스로 실행한다. 설치기가 이 서비스를 멈추고 파일을 교체한 뒤 다시 시작한다.
        var startInfo = new ProcessStartInfo
        {
            FileName = setupPath,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = tempDir,
        };
        startInfo.ArgumentList.Add("--install");
        startInfo.ArgumentList.Add("--elevated"); // SYSTEM이므로 UAC 승격 불필요
        startInfo.ArgumentList.Add("--silent");    // 창 없이 설치

        logger.LogInformation("에이전트 설치기 실행 (곧 서비스가 재시작됩니다)");
        Process.Start(startInfo);
    }
}
