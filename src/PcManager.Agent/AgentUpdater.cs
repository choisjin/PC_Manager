using System.Diagnostics;
using PcManager.Shared;

namespace PcManager.Agent;

/// <summary>
/// 서버의 업데이트 명령을 받아 최신 설치 파일을 내려받고 자기 자신을 다시 설치한다.
/// 에이전트 서비스는 SYSTEM으로 실행되므로 설치기가 관리자 권한을 갖는다.
/// 다운로드가 멈추거나 설치기가 서비스를 교체하지 못하면 '업데이트 중'에 머물지 않고 실패로 되돌려 다시 시도할 수 있게 한다.
/// </summary>
public class AgentUpdater(
    AgentSettingsStore settings,
    AgentStatusTracker status,
    ILogger<AgentUpdater> logger)
{
    // 응답 헤더까지만 적용된다. 본문은 아래 StallTimeout으로 지킨다
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(2) };

    /// <summary>다운로드 중 이만큼 데이터가 안 오면 멈춘 것으로 본다 (느려도 받고 있으면 계속)</summary>
    private static readonly TimeSpan StallTimeout = TimeSpan.FromSeconds(60);

    /// <summary>설치기를 띄운 뒤 이 안에 서비스가 교체되지 않으면 실패로 본다</summary>
    private static readonly TimeSpan InstallTimeout = TimeSpan.FromMinutes(10);

    /// <summary>설치기가 끝난 뒤 서비스가 멈추길 기다리는 시간 (교체됐다면 이 프로세스는 이미 없다)</summary>
    private static readonly TimeSpan AfterInstallerExit = TimeSpan.FromSeconds(30);

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
        // 중복 명령은 무시 (진행 중인 업데이트가 끝나거나 실패할 때까지)
        if (Interlocked.Exchange(ref _started, 1) == 1)
            return;
        status.SetUpdating(true, "준비 중");

        _ = Task.Run(async () =>
        {
            try
            {
                await RunAsync(setupUrl);
            }
            catch (Exception ex)
            {
                Interlocked.Exchange(ref _started, 0);
                status.SetUpdating(false, $"업데이트 실패: {ex.Message}");
                logger.LogError(ex, "에이전트 자가 업데이트 실패");
                FileLog($"업데이트 실패: {ex.Message}");
            }
        });
    }

    private async Task RunAsync(string? setupUrl)
    {
        FileLog("=== 자가 업데이트 시작 ===");

        var url = !string.IsNullOrWhiteSpace(setupUrl)
            ? setupUrl
            : new Uri(new Uri(settings.Current.ServerUrl), InstallPaths.AgentSetup).ToString();

        var tempDir = Path.Combine(Path.GetTempPath(), "PcManagerUpdate", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tempDir);
        var setupPath = Path.Combine(tempDir, InstallPaths.AgentSetupFile);

        logger.LogInformation("에이전트 업데이트 다운로드: {Url}", url);
        FileLog($"다운로드: {url}");
        await DownloadAsync(url, setupPath);
        FileLog($"다운로드 완료: {new FileInfo(setupPath).Length} bytes");

        // 설치기를 부모(이 서비스)와 완전히 분리된 프로세스로 실행한다.
        // 그래야 설치기가 이 서비스를 멈춘 뒤에도 살아남아 파일 교체·재시작을 끝낼 수 있다.
        logger.LogInformation("에이전트 설치기 실행 (곧 서비스가 재시작됩니다)");
        var pid = DetachedProcess.Start(setupPath, "--install --elevated --silent", tempDir);
        FileLog($"설치기 실행 (분리 프로세스, PID {pid})");
        status.SetUpdating(true, "설치 중");

        await WatchInstallerAsync(pid);
    }

    private async Task DownloadAsync(string url, string path)
    {
        using var response = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();
        var total = response.Content.Headers.ContentLength;

        await using var download = await response.Content.ReadAsStreamAsync();
        await using var file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None);
        var buffer = new byte[81920];
        long received = 0;
        var shown = -1L;
        while (true)
        {
            int read;
            using (var stall = new CancellationTokenSource(StallTimeout))
            {
                try
                {
                    read = await download.ReadAsync(buffer, stall.Token);
                }
                catch (OperationCanceledException) when (stall.IsCancellationRequested)
                {
                    throw new TimeoutException($"다운로드가 {StallTimeout.TotalSeconds:0}초 동안 멈췄습니다 ({received >> 20}MB 받음)");
                }
            }
            if (read == 0)
                break;
            await file.WriteAsync(buffer.AsMemory(0, read));
            received += read;

            // 진행 표시 (트레이): 크기를 알면 %, 모르면 MB
            var step = total is > 0 ? received * 100 / total.Value : received >> 20;
            if (step != shown)
            {
                shown = step;
                status.SetUpdating(true, total is > 0 ? $"다운로드 {step}%" : $"다운로드 {step}MB");
            }
        }
        if (total is > 0 && received != total)
            throw new IOException($"다운로드가 중간에 끊겼습니다 ({received}/{total} bytes)");
    }

    /// <summary>
    /// 설치기는 이 서비스를 멈추고 파일을 바꾼 뒤 새 서비스를 띄운다 (성공하면 이 프로세스는 여기서 끝난다).
    /// 이 프로세스가 계속 살아 있으면 설치가 실패한 것이므로 예외로 알려 '업데이트 중'을 푼다.
    /// </summary>
    private static async Task WatchInstallerAsync(int pid)
    {
        var deadline = DateTime.UtcNow + InstallTimeout;
        DateTime? exitedAt = null;
        while (DateTime.UtcNow < deadline)
        {
            await Task.Delay(TimeSpan.FromSeconds(5));
            if (exitedAt is null && !IsRunning(pid))
                exitedAt = DateTime.UtcNow;
            if (exitedAt is { } at && DateTime.UtcNow - at > AfterInstallerExit)
                throw new InvalidOperationException($"설치기가 끝났지만 에이전트가 교체되지 않았습니다. 기록: {LogPath}");
        }

        // 멈춰 있는 설치기는 끝내고 다시 시도할 수 있게 한다
        try
        {
            using var process = Process.GetProcessById(pid);
            process.Kill();
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            // 이미 끝남
        }
        throw new TimeoutException($"설치가 {InstallTimeout.TotalMinutes:0}분 안에 끝나지 않았습니다. 기록: {LogPath}");
    }

    private static bool IsRunning(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }
}
