using System.Diagnostics;
using System.Globalization;
using Microsoft.Extensions.Options;
using PcManager.Shared;

namespace PcManager.Agent;

/// <summary>
/// 결과 확인 도구의 영상 자르기: 이 PC의 영상 구간을 ffmpeg로 잘라 원래 영상 폴더에 저장한다.
/// 프레임 단위로 정확하도록 다시 인코딩한다 (-c copy는 키 프레임에서만 잘려 앞뒤가 어긋난다).
/// ffmpeg: PATH → 에이전트 데이터 폴더 tools → (Windows) 서버에서 받아 둠
/// </summary>
public class VideoTrimmer(IOptions<AgentOptions> options, AgentSettingsStore settings, ILogger<VideoTrimmer> logger)
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(10) };
    private static readonly TimeSpan MaxDuration = TimeSpan.FromMinutes(30);
    private readonly SemaphoreSlim _download = new(1, 1);

    private string ToolsDirectory => Path.Combine(options.Value.DataDirectory, "tools");
    private static string ExeName => OperatingSystem.IsWindows() ? "ffmpeg.exe" : "ffmpeg";

    public async Task<VideoTrimResult> TrimAsync(string path, double startSec, double endSec)
    {
        if (!File.Exists(path))
            return new VideoTrimResult(null, "영상 파일이 없습니다: " + path);
        if (startSec < 0 || endSec <= startSec)
            return new VideoTrimResult(null, "끝 시각이 시작 시각보다 뒤여야 합니다.");

        string ffmpeg;
        try
        {
            ffmpeg = await FindFfmpegAsync();
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or TaskCanceledException)
        {
            return new VideoTrimResult(null, ex.Message);
        }

        var folder = Path.GetDirectoryName(path)!;
        var output = Path.Combine(folder, $"trim_{Fmt(startSec)}_{Fmt(endSec)}_{Path.GetFileNameWithoutExtension(path)}.mp4");
        var info = new ProcessStartInfo(ffmpeg)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };
        foreach (var arg in new[]
        {
            "-hide_banner", "-loglevel", "error", "-nostdin",
            "-ss", Fmt(startSec), "-to", Fmt(endSec), "-i", path,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-movflags", "+faststart", "-y", output,
        })
            info.ArgumentList.Add(arg);

        logger.LogInformation("영상 자르기: {Path} {Start}~{End}초 → {Output}", path, startSec, endSec, output);
        using var process = Process.Start(info) ?? throw new InvalidOperationException("ffmpeg를 시작하지 못했습니다.");
        var errors = process.StandardError.ReadToEndAsync();
        _ = process.StandardOutput.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(MaxDuration);
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            return new VideoTrimResult(null, "영상 자르기가 너무 오래 걸려 멈췄습니다.");
        }

        if (process.ExitCode != 0 || !File.Exists(output) || new FileInfo(output).Length == 0)
        {
            var tail = string.Join(" ", (await errors).Split('\n', StringSplitOptions.RemoveEmptyEntries).TakeLast(4));
            return new VideoTrimResult(null, $"ffmpeg 실패 (코드 {process.ExitCode}): {tail}");
        }
        return new VideoTrimResult(output, null);
    }

    private static string Fmt(double seconds) => seconds.ToString("0.###", CultureInfo.InvariantCulture);

    private async Task<string> FindFfmpegAsync()
    {
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir.Trim('"'), ExeName);
            if (File.Exists(candidate))
                return candidate;
        }
        var local = Path.Combine(ToolsDirectory, ExeName);
        if (File.Exists(local))
            return local;
        if (!OperatingSystem.IsWindows())
            throw new InvalidOperationException("ffmpeg가 없습니다. sudo apt install ffmpeg");

        // Windows: 서버 패키지에 들어 있는 ffmpeg.exe를 한 번 받아 둔다
        await _download.WaitAsync();
        try
        {
            if (File.Exists(local))
                return local;
            var current = settings.Current;
            Directory.CreateDirectory(ToolsDirectory);
            var temp = local + ".download";
            using (var request = new HttpRequestMessage(HttpMethod.Get, new Uri(new Uri(current.ServerUrl), InstallPaths.FfmpegWindows)))
            {
                if (!string.IsNullOrEmpty(current.Token))
                    request.Headers.Add(AgentHeaders.Token, current.Token);
                using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
                if (!response.IsSuccessStatusCode)
                    throw new InvalidOperationException("ffmpeg가 없습니다 (서버에도 없음). 이 PC에 ffmpeg를 설치하거나 PATH에 넣어 주세요.");
                await using var source = await response.Content.ReadAsStreamAsync();
                await using var file = File.Create(temp);
                await source.CopyToAsync(file);
            }
            File.Move(temp, local, overwrite: true);
            logger.LogInformation("ffmpeg를 서버에서 받았습니다: {Path}", local);
            return local;
        }
        finally
        {
            _download.Release();
        }
    }
}
