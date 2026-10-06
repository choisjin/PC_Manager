using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
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

    // ── 재생 준비: 브라우저가 길이를 모르거나(Infinity) 탐색이 안 되는 영상을 탐색 가능한 사본으로

    private static readonly string[] PlayableCodecs = ["h264", "vp8", "vp9", "av1"];
    private static readonly TimeSpan CacheLifetime = TimeSpan.FromDays(3);
    private readonly ConcurrentDictionary<string, Lazy<Task<VideoPrepareResult>>> _converting = new();

    private string CacheDirectory => Path.Combine(options.Value.DataDirectory, "video-cache");

    private sealed record Probe(string Format, string? Codec, double? Duration, double? Fps, bool HasAudio, string? AudioCodec);

    public async Task<VideoPrepareResult> PrepareAsync(string path, bool convert)
    {
        if (!File.Exists(path))
            return new VideoPrepareResult(null, false, null, null, null, "영상 파일이 없습니다: " + path);
        string ffmpeg;
        try
        {
            ffmpeg = await FindFfmpegAsync();
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or TaskCanceledException)
        {
            // ffmpeg가 없으면 원본 그대로 (브라우저가 할 수 있는 만큼)
            return new VideoPrepareResult(path, false, null, null, ex.Message, null);
        }

        var probe = await ProbeAsync(ffmpeg, path);
        var mp4Family = probe.Format.Contains("mp4") || probe.Format.Contains("mov");
        var webmFamily = probe.Format.Contains("matroska") || probe.Format.Contains("webm");
        var codecOk = probe.Codec is not null && PlayableCodecs.Contains(probe.Codec);
        var transcode = !codecOk || !(mp4Family || webmFamily);
        // webm·mkv는 브라우저 녹화처럼 탐색 색인(cues)이 없는 경우가 많고 -i로는 구분이 안 돼 늘 색인을 넣은 사본으로 (영상은 복사라 빠름)
        var needsConvert = transcode || webmFamily || probe.Duration is null;
        if (!needsConvert)
            return new VideoPrepareResult(path, false, probe.Duration, probe.Fps, null, null);

        var file = new FileInfo(path);
        var key = Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes($"{file.FullName}|{file.Length}|{file.LastWriteTimeUtc.Ticks}")))[..20];
        // 영상은 그대로 복사(빠름)하고 컨테이너만 다시 쓴다. 코덱·컨테이너를 브라우저가 못 풀면 H.264로 다시 인코딩
        var webmOut = !transcode && webmFamily && probe.Codec != "h264";
        var output = Path.Combine(CacheDirectory, key + (webmOut ? ".webm" : ".mp4"));
        var note = transcode
            ? $"브라우저가 재생할 수 없는 형식({probe.Format}, {probe.Codec ?? "코덱 모름"})이라 H.264로 변환"
            : "길이·탐색 색인을 넣은 사본";

        if (File.Exists(output))
        {
            File.SetLastWriteTimeUtc(output, DateTime.UtcNow);
            var cached = await ProbeAsync(ffmpeg, output);
            return new VideoPrepareResult(output, true, cached.Duration, cached.Fps ?? probe.Fps, note, null);
        }
        if (!convert)
            return new VideoPrepareResult(null, true, probe.Duration, probe.Fps, note, null);

        var job = _converting.GetOrAdd(output, outputKey => new Lazy<Task<VideoPrepareResult>>(async () =>
        {
            try
            {
                return await ConvertAsync(ffmpeg, path, output, probe, transcode, webmOut, note);
            }
            finally
            {
                _converting.TryRemove(output, out _);
            }
        }));
        return await job.Value;
    }

    private async Task<VideoPrepareResult> ConvertAsync(string ffmpeg, string path, string output, Probe probe, bool transcode, bool webmOut, string note)
    {
        Directory.CreateDirectory(CacheDirectory);
        CleanCache();
        var temp = output + ".part" + Path.GetExtension(output);
        var args = new List<string> { "-hide_banner", "-loglevel", "error", "-nostdin", "-fflags", "+genpts", "-i", path, "-map", "0:v:0", "-map", "0:a:0?" };
        if (transcode)
            args.AddRange(["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"]);
        else
            args.AddRange(["-c:v", "copy"]);
        if (webmOut)
            args.AddRange(["-c:a", "copy"]);
        else
            args.AddRange(probe.AudioCodec == "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "128k"]);
        if (!webmOut)
            args.AddRange(["-movflags", "+faststart"]);
        args.AddRange(["-y", temp]);

        logger.LogInformation("재생용 영상 만들기 ({Note}): {Path} → {Output}", note, path, output);
        var (exitCode, errors) = await RunAsync(ffmpeg, args, MaxDuration * 2);
        if (exitCode != 0 || !File.Exists(temp) || new FileInfo(temp).Length == 0)
        {
            File.Delete(temp);
            var tail = string.Join(" ", errors.Split('\n', StringSplitOptions.RemoveEmptyEntries).TakeLast(4));
            return new VideoPrepareResult(null, true, probe.Duration, probe.Fps, note,
                exitCode == -1 ? "재생용 영상 만들기가 너무 오래 걸려 멈췄습니다." : $"재생용 영상 만들기 실패 (코드 {exitCode}): {tail}");
        }
        File.Move(temp, output, overwrite: true);
        var made = await ProbeAsync(ffmpeg, output);
        return new VideoPrepareResult(output, true, made.Duration, made.Fps ?? probe.Fps, note, null);
    }

    /// <summary>오래 안 쓴 재생용 사본 지우기</summary>
    private void CleanCache()
    {
        try
        {
            foreach (var file in new DirectoryInfo(CacheDirectory).EnumerateFiles())
                if (DateTime.UtcNow - file.LastWriteTimeUtc > CacheLifetime)
                    file.Delete();
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    /// <summary>ffmpeg -i 로 컨테이너·코덱·길이·fps 읽기 (ffprobe 없이)</summary>
    private static async Task<Probe> ProbeAsync(string ffmpeg, string path)
    {
        var (_, text) = await RunAsync(ffmpeg, ["-hide_banner", "-nostdin", "-i", path], TimeSpan.FromSeconds(30));
        var format = Regex.Match(text, @"Input #0, (.+?), from").Groups[1].Value;
        double? duration = null;
        var d = Regex.Match(text, @"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)");
        if (d.Success)
            duration = int.Parse(d.Groups[1].Value) * 3600 + int.Parse(d.Groups[2].Value) * 60
                + double.Parse(d.Groups[3].Value, CultureInfo.InvariantCulture);
        var video = Regex.Match(text, @"Stream #0:\d+.*?: Video: (\w+)(.*)");
        double? fps = null;
        if (video.Success)
        {
            var f = Regex.Match(video.Groups[2].Value, @", (\d+(?:\.\d+)?) fps");
            if (!f.Success)
                f = Regex.Match(video.Groups[2].Value, @", (\d+(?:\.\d+)?) tbr");
            if (f.Success && double.TryParse(f.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) && v is >= 1 and <= 240)
                fps = v;
        }
        var audio = Regex.Match(text, @"Stream #0:\d+.*?: Audio: (\w+)");
        return new Probe(format, video.Success ? video.Groups[1].Value : null, duration is > 0 ? duration : null, fps,
            audio.Success, audio.Success ? audio.Groups[1].Value : null);
    }

    /// <summary>ffmpeg 실행 → (종료 코드, stderr). 시간 초과면 코드 -1</summary>
    private static async Task<(int ExitCode, string Errors)> RunAsync(string ffmpeg, IEnumerable<string> args, TimeSpan limit)
    {
        var info = new ProcessStartInfo(ffmpeg)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };
        foreach (var arg in args)
            info.ArgumentList.Add(arg);
        using var process = Process.Start(info) ?? throw new InvalidOperationException("ffmpeg를 시작하지 못했습니다.");
        var errors = process.StandardError.ReadToEndAsync();
        _ = process.StandardOutput.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(limit);
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            return (-1, "");
        }
        return (process.ExitCode, await errors);
    }

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
