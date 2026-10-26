using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
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
        logger.LogInformation("영상 자르기: {Path} {Start}~{End}초 → {Output}", path, startSec, endSec, output);
        var (exitCode, errors) = await RunGpuAsync(ffmpeg, (decode, encoder) =>
        [
            "-hide_banner", "-loglevel", "error", "-nostdin",
            "-ss", Fmt(startSec), "-to", Fmt(endSec), .. FfmpegGpu.DecodeArgs(decode), "-i", path,
            .. FfmpegGpu.EncodeArgs(encoder),
            "-c:a", "aac", "-movflags", "+faststart", "-y", output,
        ], MaxDuration);
        if (exitCode == -1)
            return new VideoTrimResult(null, "영상 자르기가 너무 오래 걸려 멈췄습니다.");
        if (exitCode != 0 || !File.Exists(output) || new FileInfo(output).Length == 0)
            return new VideoTrimResult(null, $"ffmpeg 실패 (코드 {exitCode}): {Tail(errors)}");
        return new VideoTrimResult(output, null);
    }

    private static string Fmt(double seconds) => seconds.ToString("0.###", CultureInfo.InvariantCulture);

    // ── 재생 준비: 브라우저가 그대로 재생·탐색할 수 있으면 원본을, 아니면 (사용자가 승인하면) 탐색 가능한 사본을 만든다

    private static readonly string[] PlayableCodecs = ["h264", "vp8", "vp9", "av1"];
    // Chrome이 Matroska·WebM 안에서 풀 수 있는 소리 (mp4는 예전처럼 따로 보지 않는다)
    private static readonly string[] PlayableAudio = ["aac", "opus", "vorbis", "mp3", "flac"];
    // 실패하고 남은 만들다 만 사본(.part)을 지우는 나이. 완성된 사본은 Result 탭에서 사용자가 직접 지운다
    private static readonly TimeSpan PartLifetime = TimeSpan.FromDays(1);
    // 변환 전 남겨 둘 여유 공간 (사본은 원본 크기쯤)
    private const long SpaceMargin = 512L * 1024 * 1024;
    private const string IndexName = "index.json";
    private readonly object _indexLock = new();
    private readonly ConcurrentDictionary<string, Lazy<Task<VideoPrepareResult>>> _converting = new();
    // 진행 (결과 확인 화면이 속도·남은 시간을 보여 준다): 원본 경로 → 사본 만드는 중, ffmpeg 받는 중
    private readonly ConcurrentDictionary<string, ConvertProgress> _progress = new();
    private FfmpegDownload? _ffmpegDownload;

    private string CacheDirectory => Path.Combine(options.Value.DataDirectory, "video-cache");

    internal sealed record Probe(string Format, string? Codec, double? Duration, double? Fps, bool HasAudio, string? AudioCodec, int Width, int Height);

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
        var audioOk = !webmFamily || !probe.HasAudio || probe.AudioCodec is not null && PlayableAudio.Contains(probe.AudioCodec);
        // 바로 재생할 수 없는 까닭 (null이면 원본 그대로). Chrome은 길이·탐색 색인(Cues)이 있는 mkv·webm을 그대로 재생·탐색한다 (OBS 녹화 등).
        // 색인은 ffmpeg -i로 알 수 없어 파일 머리를 직접 읽는다 (브라우저 녹화·비정상 종료된 녹화는 길이·색인이 없다)
        var reason = !(mp4Family || webmFamily) ? $"브라우저가 재생할 수 없는 형식({probe.Format})입니다"
            : !codecOk ? $"브라우저가 재생할 수 없는 코덱({probe.Codec ?? "모름"})입니다"
            : !audioOk ? $"브라우저가 재생할 수 없는 소리 형식({probe.AudioCodec})입니다"
            : probe.Duration is null ? "영상 길이 정보가 없습니다 (녹화가 비정상 종료됐거나 브라우저로 녹화한 영상)"
            : webmFamily && !MatroskaIndex.HasCues(path) ? "탐색 색인이 없어 원하는 위치로 바로 이동할 수 없습니다 (녹화가 비정상 종료됐을 수 있음)"
            : null;
        if (reason is null)
            return new VideoPrepareResult(path, false, probe.Duration, probe.Fps, null, null);

        var file = new FileInfo(path);
        var key = Convert.ToHexString(SHA1.HashData(Encoding.UTF8.GetBytes($"{file.FullName}|{file.Length}|{file.LastWriteTimeUtc.Ticks}")))[..20];
        // 영상은 그대로 복사(빠름)하고 컨테이너만 다시 쓴다. 코덱·컨테이너를 브라우저가 못 풀면 H.264로 다시 인코딩
        var webmOut = !transcode && webmFamily && probe.Codec != "h264";
        var output = Path.Combine(CacheDirectory, key + (webmOut ? ".webm" : ".mp4"));
        var note = transcode
            ? $"H.264로 다시 인코딩 ({probe.Format}, {probe.Codec ?? "코덱 모름"})"
            : "영상은 그대로 두고 길이·탐색 색인을 넣은 사본";

        if (File.Exists(output))
        {
            File.SetLastWriteTimeUtc(output, DateTime.UtcNow);
            UpdateIndex(index => index[Path.GetFileName(output)] = path);
            var cached = await ProbeAsync(ffmpeg, output);
            return new VideoPrepareResult(output, true, cached.Duration, cached.Fps ?? probe.Fps, note, null, reason, transcode, file.Length);
        }
        var drive = DriveOf(CacheDirectory);
        var free = FreeSpace(drive);
        // 사용자 승인 전: 왜 변환해야 하는지 · 무엇을 하는지 · 사본 크기·둘 곳의 남은 공간을 알려 준다
        if (!convert)
            return new VideoPrepareResult(null, true, probe.Duration, probe.Fps, note, null, reason, transcode, file.Length, drive?.Name, free);
        if (drive is not null && free < file.Length + SpaceMargin)
            return new VideoPrepareResult(null, true, probe.Duration, probe.Fps, note,
                $"테스트 PC {drive.Name}의 남은 공간이 부족해 변환할 수 없습니다 (필요 약 {Bytes(file.Length + SpaceMargin)}, 남음 {Bytes(free)}). Result 탭에서 사본을 지우거나 공간을 비우세요.",
                reason, transcode, file.Length, drive.Name, free);

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
        CleanParts();
        UpdateIndex(index => index[Path.GetFileName(output)] = path);
        var temp = output + ".part" + Path.GetExtension(output);
        // 다시 인코딩하면 GPU 디코딩·인코딩 (decode·encoder), 아니면 그대로 옮겨 담는다
        List<string> Args(bool decode, string? encoder)
        {
            var args = new List<string> { "-hide_banner", "-loglevel", "error", "-nostdin", "-fflags", "+genpts" };
            if (transcode)
                args.AddRange(FfmpegGpu.DecodeArgs(decode));
            args.AddRange(["-i", path, "-map", "0:v:0", "-map", "0:a:0?"]);
            args.AddRange(transcode ? FfmpegGpu.EncodeArgs(encoder) : ["-c:v", "copy"]);
            // webm에는 Opus·Vorbis만 들어간다
            if (webmOut)
                args.AddRange(probe.AudioCodec is "opus" or "vorbis" ? ["-c:a", "copy"] : ["-c:a", "libopus", "-b:a", "128k"]);
            else
                args.AddRange(probe.AudioCodec == "aac" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "128k"]);
            if (!webmOut)
                args.AddRange(["-movflags", "+faststart"]);
            // -progress: 처리한 영상 시각(out_time)·쓴 크기를 줄마다 내보낸다 → 진행률·속도
            args.AddRange(["-progress", "pipe:1", "-nostats", "-y", temp]);
            return args;
        }

        logger.LogInformation("재생용 영상 만들기 ({Note}): {Path} → {Output}", note, path, output);
        var progress = new ConvertProgress(new FileInfo(path).Length, probe.Duration);
        _progress[path] = progress;
        int exitCode;
        string errors;
        try
        {
            (exitCode, errors) = transcode
                ? await RunGpuAsync(ffmpeg, Args, MaxDuration * 2, progress.Read)
                : await RunAsync(ffmpeg, Args(false, null), MaxDuration * 2, progress.Read);
        }
        finally
        {
            _progress.TryRemove(path, out _);
        }
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

    /// <summary>재생 준비 진행: 이 영상의 사본을 만드는 중이면 그 진행, 아니면 ffmpeg를 받는 중이면 그 진행, 둘 다 아니면 null</summary>
    public VideoPrepareProgress? GetProgress(string path)
    {
        if (_progress.TryGetValue(path, out var convert))
            return convert.Snapshot();
        return _ffmpegDownload?.Snapshot();
    }

    /// <summary>ffmpeg -progress 출력 (out_time_us=…, total_size=…)으로 본 사본 만들기 진행</summary>
    private sealed class ConvertProgress(long inputBytes, double? duration)
    {
        private readonly DateTime _started = DateTime.UtcNow;
        private double _outSeconds;
        private long _outBytes;

        public void Read(string line)
        {
            var eq = line.IndexOf('=');
            if (eq <= 0)
                return;
            var key = line[..eq];
            var value = line[(eq + 1)..].Trim();
            // out_time_ms도 실제로는 마이크로초 (옛 ffmpeg는 out_time_us가 없다)
            if (key is "out_time_us" or "out_time_ms" && long.TryParse(value, out var us) && us >= 0)
                _outSeconds = us / 1_000_000.0;
            else if (key == "total_size" && long.TryParse(value, out var size) && size >= 0)
                _outBytes = size;
        }

        /// <summary>진행률 = 처리한 시각 / 길이 (길이를 모르면 쓴 크기 / 원본 크기). Bytes = 진행률 × 원본 크기</summary>
        public VideoPrepareProgress Snapshot()
        {
            var fraction = duration is > 0 ? _outSeconds / duration.Value : inputBytes > 0 ? (double)_outBytes / inputBytes : 0;
            fraction = Math.Clamp(fraction, 0, 0.999);
            return new VideoPrepareProgress("convert", fraction, (long)(fraction * inputBytes), inputBytes, (DateTime.UtcNow - _started).TotalSeconds);
        }
    }

    /// <summary>서버에서 ffmpeg.exe 받는 진행</summary>
    private sealed class FfmpegDownload(long total)
    {
        private readonly DateTime _started = DateTime.UtcNow;
        private long _received;

        public void Add(int bytes) => Interlocked.Add(ref _received, bytes);

        public VideoPrepareProgress Snapshot()
        {
            var received = Interlocked.Read(ref _received);
            return new VideoPrepareProgress("ffmpeg", total > 0 ? Math.Min(1, (double)received / total) : 0, received, total,
                (DateTime.UtcNow - _started).TotalSeconds);
        }
    }

    /// <summary>실패하고 남은 만들다 만 사본(.part) 지우기 (완성된 사본은 사용자가 Result 탭에서 지운다)</summary>
    private void CleanParts()
    {
        try
        {
            foreach (var file in new DirectoryInfo(CacheDirectory).EnumerateFiles("*.part*"))
                if (DateTime.UtcNow - file.LastWriteTimeUtc > PartLifetime && !_converting.ContainsKey(OutputOf(file.FullName)))
                    file.Delete();
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    /// <summary>만드는 중 파일(사본.part.확장자) → 완성될 사본 경로</summary>
    private static string OutputOf(string path)
    {
        var at = path.IndexOf(".part", StringComparison.Ordinal);
        return at < 0 ? path : path[..at];
    }

    // ── 저장 공간 (Result 탭): 드라이브 남은 공간 · 재생용 사본 목록 · 지우기

    /// <summary>사본 파일 이름 → 원본 경로 (목록에 원본을 보여 주려고)</summary>
    private Dictionary<string, string> ReadIndex()
    {
        lock (_indexLock)
        {
            try
            {
                var file = Path.Combine(CacheDirectory, IndexName);
                return File.Exists(file)
                    ? JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(file)) ?? []
                    : [];
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
            {
                return [];
            }
        }
    }

    private void UpdateIndex(Action<Dictionary<string, string>> change)
    {
        lock (_indexLock)
        {
            try
            {
                var index = ReadIndex();
                change(index);
                // 지워진 사본은 뺀다 (만드는 중인 것은 둔다)
                foreach (var name in index.Keys.Where(n => !File.Exists(Path.Combine(CacheDirectory, n))
                             && !File.Exists(Path.Combine(CacheDirectory, n + ".part" + Path.GetExtension(n)))
                             && !_converting.ContainsKey(Path.Combine(CacheDirectory, n))).ToList())
                    index.Remove(name);
                Directory.CreateDirectory(CacheDirectory);
                File.WriteAllText(Path.Combine(CacheDirectory, IndexName), JsonSerializer.Serialize(index));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                logger.LogWarning("재생용 사본 목록을 저장하지 못했습니다: {Message}", ex.Message);
            }
        }
    }

    public VideoStorageInfo GetStorage()
    {
        var index = ReadIndex();
        var cache = new List<VideoCacheEntry>();
        try
        {
            if (Directory.Exists(CacheDirectory))
                foreach (var file in new DirectoryInfo(CacheDirectory).EnumerateFiles())
                {
                    if (file.Name == IndexName)
                        continue;
                    var output = OutputOf(file.FullName);
                    cache.Add(new VideoCacheEntry(file.Name, file.Length, file.LastWriteTimeUtc, index.GetValueOrDefault(Path.GetFileName(output)),
                        output != file.FullName && _converting.ContainsKey(output)));
                }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogWarning("재생용 사본 폴더를 읽지 못했습니다: {Message}", ex.Message);
        }
        return new VideoStorageInfo(Drives(), CacheDirectory, cache.OrderByDescending(c => c.LastUsed).ToList());
    }

    /// <summary>재생용 사본 지우기 (원본은 그대로). 만드는 중인 것은 못 지운다</summary>
    public VideoCacheDeleteResult DeleteCache(IReadOnlyList<string> names)
    {
        var deleted = 0;
        long freed = 0;
        var failed = new List<string>();
        foreach (var name in names.Distinct())
        {
            // 사본 폴더 안 파일 이름만 (경로·목록 파일은 안 됨)
            var full = Path.Combine(CacheDirectory, name);
            if (name != Path.GetFileName(name) || name == IndexName || _converting.ContainsKey(OutputOf(full)))
            {
                failed.Add(name);
                continue;
            }
            try
            {
                if (!File.Exists(full))
                    continue;
                var size = new FileInfo(full).Length;
                File.Delete(full);
                deleted++;
                freed += size;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                failed.Add(name);
            }
        }
        if (deleted > 0)
            UpdateIndex(_ => { });
        logger.LogInformation("재생용 사본 {Count}개 지움 ({Bytes})", deleted, Bytes(freed));
        return new VideoCacheDeleteResult(deleted, freed, failed);
    }

    // Linux: 장치·가상 파일 시스템 마운트는 빼고 디스크만
    internal static readonly string[] SkipMounts = ["/snap", "/var/snap", "/run", "/sys", "/proc", "/dev", "/boot"];

    private static List<DriveSpace> Drives()
    {
        var list = new List<DriveSpace>();
        foreach (var d in DriveInfo.GetDrives())
        {
            try
            {
                if (!d.IsReady || d.DriveType is not (DriveType.Fixed or DriveType.Removable) || d.TotalSize < 1L << 30)
                    continue;
                if (!OperatingSystem.IsWindows() && SkipMounts.Any(m => d.Name == m || d.Name.StartsWith(m + "/", StringComparison.Ordinal)))
                    continue;
                var label = OperatingSystem.IsWindows() && !string.IsNullOrWhiteSpace(d.VolumeLabel) ? d.VolumeLabel : null;
                list.Add(new DriveSpace(d.Name, label, d.AvailableFreeSpace, d.TotalSize));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // 읽을 수 없는 드라이브는 건너뛴다
            }
        }
        return list;
    }

    /// <summary>경로가 든 드라이브 (Linux는 가장 깊은 마운트 지점)</summary>
    private static DriveInfo? DriveOf(string path)
    {
        try
        {
            var full = Path.GetFullPath(path);
            var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            return DriveInfo.GetDrives()
                .Where(d => full.StartsWith(d.RootDirectory.FullName, comparison))
                .MaxBy(d => d.RootDirectory.FullName.Length);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return null;
        }
    }

    private static long FreeSpace(DriveInfo? drive)
    {
        try
        {
            return drive is { IsReady: true } ? drive.AvailableFreeSpace : 0;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }

    private static string Bytes(long bytes) => bytes >= 1L << 30
        ? (bytes / (double)(1L << 30)).ToString("0.0", CultureInfo.InvariantCulture) + " GB"
        : (bytes / (double)(1L << 20)).ToString("0", CultureInfo.InvariantCulture) + " MB";

    /// <summary>ffmpeg -i 로 컨테이너·코덱·길이·fps 읽기 (ffprobe 없이)</summary>
    internal static async Task<Probe> ProbeAsync(string ffmpeg, string path)
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
        int width = 0, height = 0;
        if (video.Success)
        {
            var size = Regex.Match(video.Groups[2].Value, @", (\d{2,5})x(\d{2,5})");
            if (size.Success)
            {
                width = int.Parse(size.Groups[1].Value);
                height = int.Parse(size.Groups[2].Value);
            }
            var f = Regex.Match(video.Groups[2].Value, @", (\d+(?:\.\d+)?) fps");
            if (!f.Success)
                f = Regex.Match(video.Groups[2].Value, @", (\d+(?:\.\d+)?) tbr");
            if (f.Success && double.TryParse(f.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) && v is >= 1 and <= 240)
                fps = v;
        }
        var audio = Regex.Match(text, @"Stream #0:\d+.*?: Audio: (\w+)");
        return new Probe(format, video.Success ? video.Groups[1].Value : null, duration is > 0 ? duration : null, fps,
            audio.Success, audio.Success ? audio.Groups[1].Value : null, width, height);
    }

    /// <summary>
    /// 다시 인코딩하는 ffmpeg 실행: GPU 디코딩·인코딩으로 먼저, 실패하면 디코딩 → 인코딩 차례로 CPU로 바꿔 다시 한다
    /// (CPU로 바꿔서 되면 그쪽은 앞으로 CPU로만). build(GPU 디코딩, 하드웨어 인코더 또는 null) → 인자
    /// </summary>
    private async Task<(int ExitCode, string Errors)> RunGpuAsync(string ffmpeg, Func<bool, string?, List<string>> build, TimeSpan limit,
        Action<string>? onOutput = null)
    {
        var decode = FfmpegGpu.Decode && !_transcodeDecodeOff;
        var encoder = await FfmpegGpu.EncoderAsync(ffmpeg);
        logger.LogInformation("ffmpeg 인코딩: {Encoder}, 디코딩 {Decode}", encoder ?? "libx264(CPU)", decode ? "GPU" : "CPU");
        var result = await RunAsync(ffmpeg, build(decode, encoder), limit, onOutput);
        // 0: 됨, -1: 시간 초과 (다시 해도 오래 걸린다)
        if (result.ExitCode is 0 or -1)
            return result;
        if (decode)
        {
            var retry = await RunAsync(ffmpeg, build(false, encoder), limit, onOutput);
            if (retry.ExitCode == 0)
            {
                // 다시 인코딩할 때만 CPU로 푼다 (하드웨어 인코더가 디코딩 장치와 함께 못 쓰는 경우 — 예: AMF와 DXVA2. 영상 분석의 GPU 디코딩은 그대로)
                _transcodeDecodeOff = true;
                logger.LogWarning("GPU 디코딩 + {Encoder} 인코딩 실패, 다시 인코딩할 때는 CPU로 풉니다: {Error}", encoder ?? "libx264", Tail(result.Errors));
                return retry;
            }
            result = retry;
        }
        if (encoder is not null)
        {
            var retry = await RunAsync(ffmpeg, build(false, null), limit, onOutput);
            if (retry.ExitCode == 0)
                FfmpegGpu.EncodeFailed(logger, encoder, Tail(result.Errors));
            return retry;
        }
        return result;
    }

    // 다시 인코딩할 때 GPU 디코딩을 끔 (GPU 디코딩과 하드웨어 인코더를 함께 못 쓰는 PC)
    private static volatile bool _transcodeDecodeOff;

    /// <summary>ffmpeg stderr 끝 몇 줄</summary>
    private static string Tail(string errors) => string.Join(" ", errors.Split('\n', StringSplitOptions.RemoveEmptyEntries).TakeLast(4));

    /// <summary>ffmpeg 실행 → (종료 코드, stderr). 시간 초과면 코드 -1. onOutput: stdout 줄마다 (-progress)</summary>
    private static async Task<(int ExitCode, string Errors)> RunAsync(string ffmpeg, IEnumerable<string> args, TimeSpan limit, Action<string>? onOutput = null)
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
        var output = onOutput is null ? process.StandardOutput.ReadToEndAsync() : ReadLinesAsync(process.StandardOutput, onOutput);
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
        await output;
        return (process.ExitCode, await errors);
    }

    private static async Task<string> ReadLinesAsync(StreamReader reader, Action<string> onLine)
    {
        while (await reader.ReadLineAsync() is { } line)
            onLine(line);
        return "";
    }

    internal async Task<string> FindFfmpegAsync()
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
                var download = new FfmpegDownload(response.Content.Headers.ContentLength ?? 0);
                _ffmpegDownload = download;
                try
                {
                    var buffer = new byte[256 * 1024];
                    int read;
                    while ((read = await source.ReadAsync(buffer)) > 0)
                    {
                        await file.WriteAsync(buffer.AsMemory(0, read));
                        download.Add(read);
                    }
                }
                finally
                {
                    _ffmpegDownload = null;
                }
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

/// <summary>
/// Matroska·WebM 탐색 색인(Cues) 확인: ffmpeg -i로는 알 수 없어 파일을 직접 읽는다.
/// Segment 앞쪽 SeekHead가 가리키는 위치에 정말 Cues가 있는지 → 앞쪽에 Cues가 바로 있는지 → 없으면 끝부분에서 Cues(첫 자식이 CuePoint)를 찾는다.
/// 색인이 없으면 브라우저가 멀리 이동할 때 파일을 처음부터 읽어야 해 네트워크로는 사실상 탐색이 안 된다
/// </summary>
internal static class MatroskaIndex
{
    private const uint Ebml = 0x1A45DFA3, Segment = 0x18538067, SeekHead = 0x114D9B74, Seek = 0x4DBB, SeekId = 0x53AB,
        SeekPosition = 0x53AC, Cues = 0x1C53BB6B, CuePoint = 0xBB, Cluster = 0x1F43B675;
    private const int HeadBytes = 1 << 20;
    private const int TailBytes = 8 << 20;

    public static bool HasCues(string path)
    {
        try
        {
            using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var head = new byte[(int)Math.Min(file.Length, HeadBytes)];
            file.ReadExactly(head);
            var pos = 0;
            if (!Element(head, ref pos, out var id, out var size) || id != Ebml || size < 0 || pos + size > head.Length)
                return false;
            pos += (int)size;
            if (!Element(head, ref pos, out id, out _) || id != Segment)
                return false;
            long segmentStart = pos;
            while (pos < head.Length)
            {
                if (!Element(head, ref pos, out id, out size))
                    break;
                if (id == Cues)
                    return true;
                // 크기를 모르는(-1) 요소·첫 Cluster에서 멈춘다 (그 뒤는 영상 데이터)
                if (id == Cluster || size < 0 || pos + size > head.Length)
                    break;
                if (id == SeekHead && SeekHeadPointsToCues(file, head, pos, (int)size, segmentStart))
                    return true;
                pos += (int)size;
            }
            return TailHasCues(file);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return false;
        }
    }

    /// <summary>EBML 요소 머리: ID(표지 비트 포함 1~4바이트) · 크기(1~8바이트, 모두 1이면 모름 = -1)</summary>
    private static bool Element(byte[] buffer, ref int pos, out uint id, out long size)
    {
        id = 0;
        size = 0;
        if (pos >= buffer.Length)
            return false;
        var idLength = BitOperations.LeadingZeroCount((uint)buffer[pos]) - 23;
        if (idLength is < 1 or > 4 || pos + idLength > buffer.Length)
            return false;
        for (var i = 0; i < idLength; i++)
            id = (id << 8) | buffer[pos + i];
        pos += idLength;
        if (pos >= buffer.Length)
            return false;
        var sizeLength = BitOperations.LeadingZeroCount((uint)buffer[pos]) - 23;
        if (sizeLength is < 1 or > 8 || pos + sizeLength > buffer.Length)
            return false;
        long value = buffer[pos] & (0xFF >> sizeLength);
        var unknown = value == 0xFF >> sizeLength;
        for (var i = 1; i < sizeLength; i++)
        {
            value = (value << 8) | buffer[pos + i];
            unknown &= buffer[pos + i] == 0xFF;
        }
        pos += sizeLength;
        size = unknown ? -1 : value;
        return true;
    }

    private static bool SeekHeadPointsToCues(FileStream file, byte[] buffer, int start, int length, long segmentStart)
    {
        var pos = start;
        var end = start + length;
        while (pos < end)
        {
            if (!Element(buffer, ref pos, out var id, out var size) || size < 0 || pos + size > end)
                return false;
            if (id == Seek)
            {
                uint target = 0;
                long position = -1;
                var p = pos;
                var seekEnd = pos + (int)size;
                while (p < seekEnd)
                {
                    if (!Element(buffer, ref p, out var childId, out var childSize) || childSize < 0 || p + childSize > seekEnd)
                        break;
                    if (childId == SeekId && childSize <= 4)
                    {
                        target = 0;
                        for (var i = 0; i < childSize; i++)
                            target = (target << 8) | buffer[p + i];
                    }
                    else if (childId == SeekPosition && childSize <= 8)
                    {
                        position = 0;
                        for (var i = 0; i < childSize; i++)
                            position = (position << 8) | buffer[p + i];
                    }
                    p += (int)childSize;
                }
                if (target == Cues && position >= 0 && IsCuesAt(file, segmentStart + position))
                    return true;
            }
            pos += (int)size;
        }
        return false;
    }

    private static bool IsCuesAt(FileStream file, long offset)
    {
        if (offset < 0 || offset + 4 > file.Length)
            return false;
        var id = new byte[4];
        file.Position = offset;
        file.ReadExactly(id);
        return id[0] == 0x1C && id[1] == 0x53 && id[2] == 0xBB && id[3] == 0x6B;
    }

    /// <summary>SeekHead가 없거나 Cues를 가리키지 않을 때: 끝부분에서 Cues를 찾아 첫 자식이 CuePoint이고 크기가 파일 안에 맞는지 본다</summary>
    private static bool TailHasCues(FileStream file)
    {
        var length = (int)Math.Min(file.Length, TailBytes);
        var tail = new byte[length];
        file.Position = file.Length - length;
        file.ReadExactly(tail);
        for (var i = length - 6; i >= 0; i--)
        {
            if (tail[i] != 0x1C || tail[i + 1] != 0x53 || tail[i + 2] != 0xBB || tail[i + 3] != 0x6B)
                continue;
            var p = i;
            if (!Element(tail, ref p, out _, out var size) || size <= 0 || p + size > length)
                continue;
            if (Element(tail, ref p, out var child, out _) && child == CuePoint)
                return true;
        }
        return false;
    }
}
