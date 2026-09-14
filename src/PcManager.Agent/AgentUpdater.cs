using PcManager.Shared;

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

    private static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PcManager", "Agent", "update.log");

    private int _started;

    private static void FileLog(string message)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
            File.AppendAllText(LogPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
        }
        catch (IOException)
        {
            // 로그 실패는 무시
        }
    }

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
                FileLog($"업데이트 준비 실패: {ex.Message}");
            }
        });
    }

    private async Task RunAsync(string? setupUrl)
    {
        status.SetUpdating(true);
        FileLog("=== 자가 업데이트 시작 ===");

        var url = !string.IsNullOrWhiteSpace(setupUrl)
            ? setupUrl
            : new Uri(new Uri(settings.Current.ServerUrl), InstallPaths.AgentSetup).ToString();

        var tempDir = Path.Combine(Path.GetTempPath(), "PcManagerUpdate", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        var setupPath = Path.Combine(tempDir, InstallPaths.AgentSetupFile);

        logger.LogInformation("에이전트 업데이트 다운로드: {Url}", url);
        FileLog($"다운로드: {url}");
        await using (var download = await Http.GetStreamAsync(url))
        await using (var file = new FileStream(setupPath, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            await download.CopyToAsync(file);
        }
        FileLog($"다운로드 완료: {new FileInfo(setupPath).Length} bytes");

        // 설치기를 부모(이 서비스)와 완전히 분리된 프로세스로 실행한다.
        // 그래야 설치기가 이 서비스를 멈춘 뒤에도 살아남아 파일 교체·재시작을 끝낼 수 있다.
        logger.LogInformation("에이전트 설치기 실행 (곧 서비스가 재시작됩니다)");
        FileLog("설치기 실행 (분리 프로세스)");
        DetachedProcess.Start(setupPath, "--install --elevated --silent", tempDir);
    }
}
