using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using PcManager.Shared;

namespace PcManager.Agent;

/// <summary>
/// 결과 확인 도구의 영상 분석 (ReplayKit_FailAnalyzer 영상 페이지의 영상 분석과 같은 측정).
/// ffmpeg 한 번의 디코딩으로 화면 영역의 프레임마다 밝기·프레임 차이(signalstats YAVG·YDIF) · 윤곽(edgedetect 뒤 YAVG) ·
/// 윤곽이 가장 많은 칸(윤곽 영상을 8×4로 줄인 YMAX) · 평균 색(U·V 평균 → RGB)을 재고, 베젤을 주면 테두리 띠의 밝기도 잰다.
/// 검은 화면·깜박임·정지 구간·화면 전환 판정은 웹이 한다 (정지 기준을 바꿔도 다시 재지 않게).
/// 긴 영상은 구간으로 나눠 여러 ffmpeg가 앞 구간부터 재고, 앞에서부터 이어진 부분은 재는 중에도 웹이 받아 간다
/// </summary>
public class VideoAnalyzer(VideoTrimmer trimmer, ILogger<VideoAnalyzer> logger)
{
    /// <summary>프레임 한 장의 크기 (VideoAnalysisChunk 참고). 값은 ReplayKit_FailAnalyzer와 같은 정밀도 (시각 double, 나머지 float)</summary>
    public const int FrameBytes = 31;
    // 한 번에 돌려주는 프레임 수 (base64로 1.4MB: 서버 SignalR 메시지 한도 2MB를 넘으면 서버가 에이전트 연결을 끊는다)
    private const int ChunkFrames = 1_000_000 / FrameBytes;
    // 구간 길이: 첫 두 구간은 1/4·1/2로 작게(첫 결과가 빨리), 10구간 길이 뒤부터는 5배(ffmpeg 실행 횟수를 줄임)
    private const double ChunkSeconds = 60;
    // 구간마다 이만큼 앞에서 시작해 탐색 직후의 덜 준비된 프레임은 버린다 (첫 프레임의 프레임 차이도 앞 프레임과 비교되게)
    private const double Lead = 1.0;
    // 화면 영역 추정: 영상마다 뽑는 표본 수 · 표본을 뽑는 영상 수 · 표본 크기 · 칸 · 윤곽으로 볼 이웃 픽셀 밝기 차
    private const int Samples = 8;
    private const int SampleVideos = 4;
    private const int SampleWidth = 128, SampleHeight = 72;
    private const int GridX = 8, GridY = 6;
    private const int EdgeThreshold = 14;
    // 사다리꼴 영역은 펴기 전에 이 폭으로 줄인다 (어차피 320 폭으로 잰다)
    private const int WarpWidth = 640;
    // 편 화면은 가장자리를 이만큼(양쪽 3%) 안으로 잘라 잰다: 꼭짓점이 조금만 어긋나도 남는 배경 띠의 경계가 윤곽으로 잡혀
    // 꺼진 화면을 켜진 것으로 보지 않게
    private const double WarpInset = 0.03;
    // 끝난 작업을 남겨 두는 시간 · 웹이 이만큼 진행을 묻지 않으면 버려진 것으로 보고 멈춘다
    private static readonly TimeSpan Keep = TimeSpan.FromMinutes(15);
    private static readonly TimeSpan Abandoned = TimeSpan.FromMinutes(2);

    private sealed class VideoResult(string path)
    {
        public readonly string Path = path;
        // 앞에서부터 이어 붙인 프레임 (FrameBytes씩)
        public readonly List<byte> Frames = [];
        // 구간이 하나 끝날 때마다의 프레임 수 (웹이 이 경계마다 판정한다: ReplayKit_FailAnalyzer와 같은 기준값 창)
        public readonly List<int> Marks = [];
        public bool Done;
        public string? Error;
    }

    private sealed class Job
    {
        public readonly CancellationTokenSource Cancel = new();
        public readonly List<VideoResult> Results = [];
        public string State = "running";
        public double Progress;
        public string? Current;
        public string? Error;
        public double[]? Roi;
        public string? RoiSource;
        public double[]? Bezel;
        public DateTime Finished = DateTime.MaxValue;
        public DateTime Polled = DateTime.UtcNow;
    }

    /// <summary>프레임 한 장의 측정값 (T: 영상 안 초)</summary>
    private readonly record struct Row(double T, double Y, double D, double E, double G, double B, byte R, byte Gr, byte Bl);

    private readonly ConcurrentDictionary<string, Job> _jobs = new();

    public string Start(VideoAnalysisRequest request)
    {
        foreach (var (key, old) in _jobs)
            if (DateTime.UtcNow - old.Finished > Keep)
                _jobs.TryRemove(key, out _);
        var id = Guid.NewGuid().ToString("N");
        var job = new Job();
        _jobs[id] = job;
        _ = Task.Run(async () =>
        {
            string state;
            string? error = null;
            try
            {
                await RunAsync(job, request);
                state = job.Cancel.IsCancellationRequested ? "canceled" : "done";
            }
            catch (OperationCanceledException)
            {
                state = "canceled";
            }
            catch (Exception ex)
            {
                logger.LogWarning("영상 분석 실패: {Message}", ex.Message);
                (state, error) = ("failed", ex.Message);
            }
            lock (job)
            {
                // 멈추거나 실패해도 거기까지 잰 결과는 끝난 것으로 (웹이 마저 받아 판정을 닫는다). 상태와 한 번에 바꾼다
                foreach (var result in job.Results)
                    result.Done = true;
                job.State = state;
                job.Error = error;
                job.Current = null;
                job.Finished = DateTime.UtcNow;
            }
            // 프레임 값은 크다 (20시간 30fps ≈ 67MB): 다음 분석을 기다리지 않고 잠시 뒤 버린다
            await Task.Delay(Keep);
            _jobs.TryRemove(id, out _);
        });
        return id;
    }

    /// <summary>진행과 video번째 영상의 offset 프레임부터 이어지는 결과 (한 번에 ChunkFrames까지, 재는 중인 영상은 앞에서부터 이어진 부분까지)</summary>
    public VideoAnalysisProgress? GetChunks(string id, int video, int offset)
    {
        if (!_jobs.TryGetValue(id, out var job))
            return null;
        lock (job)
        {
            job.Polled = DateTime.UtcNow;
            var chunks = new List<VideoAnalysisChunk>();
            var budget = ChunkFrames;
            var more = false;
            for (var v = Math.Max(0, video); v < job.Results.Count; v++)
            {
                var r = job.Results[v];
                var have = r.Frames.Count / FrameBytes;
                var from = v == video ? Math.Clamp(offset, 0, have) : 0;
                var count = Math.Min(have - from, budget);
                var done = r.Done && from + count == have;
                if (count > 0 || done)
                    chunks.Add(new VideoAnalysisChunk(v, r.Path, from,
                        CollectionsMarshal.AsSpan(r.Frames).Slice(from * FrameBytes, count * FrameBytes).ToArray(),
                        r.Marks.Where(m => m > from && m <= from + count).ToArray(), done, done ? r.Error : null));
                budget -= count;
                // 영상은 차례로 재므로 끝나지 않은 영상 뒤는 아직 없다
                if (!done)
                {
                    more = from + count < have;
                    break;
                }
                if (budget <= 0)
                {
                    more = v + 1 < job.Results.Count;
                    break;
                }
            }
            return new VideoAnalysisProgress(job.State, job.Progress, job.Current, job.Error, job.Roi, job.RoiSource, job.Bezel, chunks, more);
        }
    }

    public bool Cancel(string id)
    {
        if (!_jobs.TryGetValue(id, out var job))
            return false;
        job.Cancel.Cancel();
        return true;
    }

    private async Task RunAsync(Job job, VideoAnalysisRequest r)
    {
        var token = job.Cancel.Token;
        var ffmpeg = await trimmer.FindFfmpegAsync();
        var probes = new List<VideoTrimmer.Probe?>();
        foreach (var path in r.Paths)
            probes.Add(File.Exists(path) ? await VideoTrimmer.ProbeAsync(ffmpeg, path) : null);
        // 동시에 돌리는 ffmpeg 수 (테스트 PC가 버티게)
        var workers = Math.Clamp(Environment.ProcessorCount / 2, 1, 4);

        // 화면 영역: 지정한 것 → 없으면 추정. 베젤은 화면을 직접 지정했을 때만
        Region roi;
        string source;
        if (Region.Parse(r.Roi) is { } given)
            (roi, source) = (given, given.IsBox && given.Bounds == (0d, 0d, 1d, 1d) ? "화면 전체" : "직접 지정");
        else
        {
            lock (job)
                job.Current = "화면 영역 추정";
            var videos = r.Paths.Select((p, i) => (Path: p, probes[i]?.Duration, Ok: probes[i] is not null))
                .Where(x => x.Ok).Take(SampleVideos).Select(x => (x.Path, x.Duration)).ToList();
            (roi, source) = await DetectScreenAsync(ffmpeg, videos, workers, token);
        }
        var bezel = Region.Parse(r.Roi) is not null ? FitBezel(roi, Region.Parse(r.Bezel)) : null;
        lock (job)
        {
            job.Roi = roi.ToArray();
            job.RoiSource = source;
            job.Bezel = bezel?.ToArray();
        }
        logger.LogInformation("영상 분석: 영상 {Count}개, 화면 영역 {Roi} ({Source}), 베젤 {Bezel}, ffmpeg {Workers}개",
            r.Paths.Count, roi, source, bezel?.ToString() ?? "없음", workers);

        var total = Math.Max(1, probes.Sum(p => p?.Duration ?? 0));
        double before = 0;
        foreach (var (path, index) in r.Paths.Select((p, i) => (p, i)))
        {
            token.ThrowIfCancellationRequested();
            var probe = probes[index];
            var result = new VideoResult(path);
            lock (job)
            {
                job.Current = Path.GetFileName(path);
                job.Results.Add(result);
            }
            if (probe is null)
            {
                lock (job)
                {
                    result.Error = "영상 파일이 없습니다";
                    result.Done = true;
                }
                continue;
            }
            var start = before;
            try
            {
                await MeasureVideoAsync(ffmpeg, path, probe.Duration, probe.Width, roi, bezel, workers, job, result, seconds =>
                {
                    lock (job)
                        job.Progress = Math.Min(1, (start + seconds) / total);
                });
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning("영상 분석 실패 {Path}: {Message}", path, ex.Message);
                lock (job)
                    result.Error = ex.Message;
            }
            before += probe.Duration ?? 0;
            lock (job)
                result.Done = true;
        }
        lock (job)
            job.Progress = 1;
    }

    /// <summary>영상 하나: 구간마다 ffmpeg를 돌리되 모든 작업자가 앞 구간부터 가져가고, 결과는 앞에서부터 차례로 붙인다</summary>
    private async Task MeasureVideoAsync(string ffmpeg, string path, double? duration, int width, Region roi, Region? bezel, int workers,
        Job job, VideoResult result, Action<double> progress)
    {
        var bounds = Chunks(duration ?? 0);
        var outputs = bounds.Select(_ => new TaskCompletionSource<List<Row>>(TaskCreationOptions.RunContinuationsAsynchronously)).ToArray();
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(job.Cancel.Token);
        var next = -1;
        async Task Work()
        {
            for (var i = Interlocked.Increment(ref next); i < bounds.Count; i = Interlocked.Increment(ref next))
            {
                try
                {
                    outputs[i].TrySetResult(await MeasureAsync(ffmpeg, path, roi, bezel, width, bounds[i].Start, bounds[i].Length, stop.Token));
                }
                catch (Exception ex)
                {
                    outputs[i].TrySetException(ex);
                    return;
                }
            }
        }
        var pool = Enumerable.Range(0, Math.Min(workers, bounds.Count)).Select(_ => Task.Run(Work)).ToList();
        var last = double.NegativeInfinity;
        try
        {
            for (var i = 0; i < bounds.Count; i++)
            {
                var rows = await outputs[i].Task.WaitAsync(stop.Token);
                lock (job)
                {
                    foreach (var row in rows)
                    {
                        // 구간 경계에서 겹친 프레임은 한 번만
                        if (row.T <= last)
                            continue;
                        Append(result.Frames, row);
                        last = row.T;
                    }
                    result.Marks.Add(result.Frames.Count / FrameBytes);
                    // 마지막 구간은 끝남과 함께 (웹이 마지막 판정을 한 번에 닫게)
                    if (i == bounds.Count - 1)
                        result.Done = true;
                    if (DateTime.UtcNow - job.Polled > Abandoned)
                        job.Cancel.Cancel();
                }
                progress(bounds[i].Length is { } length ? bounds[i].Start + length : Math.Max(0, last));
            }
        }
        finally
        {
            // 실패하거나 멈추면 남은 구간의 ffmpeg도 끝낸다
            await stop.CancelAsync();
            try
            {
                await Task.WhenAll(pool);
            }
            catch
            {
                // 작업자 예외는 위에서 이미 받았다
            }
        }
    }

    /// <summary>영상 구간: 앞은 작게(1/4 → 1/2 → 1) 잘라 첫 결과가 빨리 나오게, 뒤로 가면 크게. 길이를 모르면 통째로 하나</summary>
    private static List<(double Start, double? Length)> Chunks(double total)
    {
        var bounds = new List<(double, double?)>();
        double pos = 0;
        for (var k = 0; total - pos > 0.05; k++)
        {
            var size = k switch
            {
                0 => ChunkSeconds / 4,
                1 => ChunkSeconds / 2,
                _ => pos < 10 * ChunkSeconds ? ChunkSeconds : 5 * ChunkSeconds,
            };
            bounds.Add((pos, Math.Min(size, total - pos)));
            pos += size;
        }
        return bounds.Count > 0 ? bounds : [(0, null)];
    }

    /// <summary>
    /// [start, start+length) 구간 프레임들의 측정값. 밝기·차이·평균 색은 stdout, 윤곽·칸 윤곽·베젤 외곽은 작업 폴더의 파일로 받는다
    /// (윈도우 경로의 ':'를 필터 문법에서 피하려고 작업 폴더 안의 상대 경로). width: 영상 폭 (사다리꼴을 펴기 전에 줄일지)
    /// </summary>
    private static async Task<List<Row>> MeasureAsync(string ffmpeg, string path, Region roi, Region? bezel, int width, double start, double? length,
        CancellationToken token)
    {
        var folder = Directory.CreateTempSubdirectory("pcm_va_");
        try
        {
            var seek = Math.Max(start - Lead, 0);
            var end = length is { } l ? start + l : double.PositiveInfinity;
            var args = new List<string> { "-hide_banner", "-loglevel", "error", "-nostdin" };
            if (start > 0)
                args.AddRange(["-ss", Seconds(seek)]);
            if (length is { } span)
                args.AddRange(["-t", Seconds(span + (start - seek))]);
            var main = $"{roi.Filter(width, inset: true)},scale=320:-2,signalstats,metadata=print:file=-,"
                + "edgedetect=low=0.08:high=0.2,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=edge.txt,"
                + "scale=8:4:flags=area,signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=grid.txt";
            args.AddRange(["-copyts", "-i", path]);
            // 베젤 테두리 띠: 직사각형끼리면 외곽 전체를 재서 화면을 빼고 (ReplayKit_FailAnalyzer와 같게),
            // 꼭짓점이면 변마다 사다리꼴 띠 넷을 각각 펴서 재고 넓이로 평균한다 (얇은 띠에서 빼기의 오차가 커지지 않게)
            var boxRing = bezel is not null && roi.IsBox && bezel.IsBox;
            List<Region> strips = bezel is null ? [] : boxRing ? [bezel] : Region.Ring(bezel, roi);
            if (strips.Count > 0)
            {
                var graph = new StringBuilder($"[0:v]split={strips.Count + 1}[a]");
                for (var k = 0; k < strips.Count; k++)
                    graph.Append($"[r{k}]");
                graph.Append($";[a]{main}[out]");
                for (var k = 0; k < strips.Count; k++)
                    graph.Append($";[r{k}]{strips[k].Filter(width)},scale={(boxRing ? "160:-2" : "64:16")},signalstats,"
                        + $"metadata=print:key=lavfi.signalstats.YAVG:file=ring{k}.txt,nullsink");
                args.AddRange(["-filter_complex", graph.ToString(), "-map", "[out]"]);
            }
            else
                args.AddRange(["-vf", main]);
            args.AddRange(["-fps_mode", "passthrough", "-an", "-sn", "-dn", "-f", "null", "-"]);

            var info = new ProcessStartInfo(ffmpeg)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                WorkingDirectory = folder.FullName,
            };
            foreach (var arg in args)
                info.ArgumentList.Add(arg);
            using var process = Process.Start(info) ?? throw new InvalidOperationException("ffmpeg를 시작하지 못했습니다.");
            var errors = process.StandardError.ReadToEndAsync(CancellationToken.None);
            Dictionary<long, double[]> luma;
            try
            {
                luma = await ReadStatsAsync(process.StandardOutput, start, end, token);
                await process.WaitForExitAsync(token);
            }
            finally
            {
                if (!process.HasExited)
                    process.Kill(entireProcessTree: true);
            }
            if (process.ExitCode != 0 && luma.Count == 0)
            {
                var tail = string.Join(" ", (await errors).Split('\n', StringSplitOptions.RemoveEmptyEntries).TakeLast(3));
                throw new InvalidOperationException($"ffmpeg 실패 (코드 {process.ExitCode}): {tail}");
            }
            var edge = ReadKey(Path.Combine(folder.FullName, "edge.txt"), "YAVG", start, end);
            var grid = ReadKey(Path.Combine(folder.FullName, "grid.txt"), "YMAX", start, end);
            var rings = strips.Select((_, k) => ReadKey(Path.Combine(folder.FullName, $"ring{k}.txt"), "YAVG", start, end)).ToList();

            // 테두리 띠 밝기: 직사각형끼리는 (외곽 × 외곽 넓이 − 화면 × 화면 넓이) / 넓이 차, 꼭짓점이면 띠 넷의 넓이 가중 평균
            // (편 영상의 평균은 넓이 가중에 가깝다 — 가까운 쪽이 조금 더 무겁다)
            var areas = strips.Select(x => x.Area).ToArray();
            var rows = new List<Row>(luma.Count);
            foreach (var (key, v) in luma.OrderBy(x => x.Key))
            {
                if (!edge.TryGetValue(key, out var e))
                    continue;
                double b = 0;
                if (strips.Count > 0)
                {
                    double sum = 0, weight = 0;
                    var missing = false;
                    for (var k = 0; k < rings.Count && !missing; k++)
                    {
                        if (rings[k].TryGetValue(key, out var o))
                            (sum, weight) = (sum + o * areas[k], weight + areas[k]);
                        else
                            missing = true;
                    }
                    if (missing)
                        continue;
                    b = Math.Clamp(boxRing ? (sum - v[0] * roi.Area) / (bezel!.Area - roi.Area) : sum / weight, 0, 255);
                }
                var (red, green, blue) = Rgb(v[0], v[2], v[3]);
                rows.Add(new Row(key / 1e6, v[0], v[1], e, grid.TryGetValue(key, out var g) ? g : e, b, red, green, blue));
            }
            return rows;
        }
        finally
        {
            try
            {
                folder.Delete(recursive: true);
            }
            catch (IOException)
            {
                // 다음 정리 때 (임시 폴더)
            }
        }
    }

    /// <summary>metadata=print 출력(stdout)에서 프레임별 [YAVG, YDIF, UAVG, VAVG]. 키는 프레임 시각(µs)</summary>
    private static async Task<Dictionary<long, double[]>> ReadStatsAsync(StreamReader reader, double start, double end, CancellationToken token)
    {
        var frames = new Dictionary<long, double[]>();
        long? key = null;
        double[]? values = null;
        void Flush()
        {
            if (key is { } k && values is not null && !values.Any(double.IsNaN))
                frames[k] = values;
        }
        while (await reader.ReadLineAsync(token) is { } line)
        {
            if (PtsTime(line) is { } t)
            {
                Flush();
                var inside = t >= start - 1e-6 && t < end;
                key = inside ? Micros(t) : null;
                values = inside ? [double.NaN, double.NaN, double.NaN, double.NaN] : null;
                continue;
            }
            if (values is null || !line.StartsWith("lavfi.signalstats.", StringComparison.Ordinal))
                continue;
            var slot = line.AsSpan(18) switch
            {
                var s when s.StartsWith("YAVG=") => 0,
                var s when s.StartsWith("YDIF=") => 1,
                var s when s.StartsWith("UAVG=") => 2,
                var s when s.StartsWith("VAVG=") => 3,
                _ => -1,
            };
            if (slot >= 0 && double.TryParse(line.AsSpan(23), NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
                values[slot] = value;
        }
        Flush();
        return frames;
    }

    /// <summary>key=로 한 값만 찍은 metadata=print 파일 → 프레임 시각(µs)별 값</summary>
    private static Dictionary<long, double> ReadKey(string file, string name, double start, double end)
    {
        var values = new Dictionary<long, double>();
        if (!File.Exists(file))
            return values;
        var prefix = "lavfi.signalstats." + name + "=";
        long? key = null;
        foreach (var line in File.ReadLines(file))
        {
            if (PtsTime(line) is { } t)
            {
                key = t >= start - 1e-6 && t < end ? Micros(t) : null;
                continue;
            }
            if (key is { } k && line.StartsWith(prefix, StringComparison.Ordinal)
                && double.TryParse(line.AsSpan(prefix.Length), NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
                values[k] = value;
        }
        return values;
    }

    /// <summary>"frame:12   pts:6006    pts_time:0.2002" → 0.2002</summary>
    private static double? PtsTime(string line)
    {
        var at = line.IndexOf("pts_time:", StringComparison.Ordinal);
        if (at < 0)
            return null;
        var text = line.AsSpan(at + 9).Trim();
        var space = text.IndexOf(' ');
        if (space >= 0)
            text = text[..space];
        return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var t) ? t : null;
    }

    private static long Micros(double seconds) => (long)Math.Round(seconds * 1e6);

    private static void Append(List<byte> frames, Row row)
    {
        Span<byte> bytes = stackalloc byte[FrameBytes];
        BinaryPrimitives.WriteDoubleLittleEndian(bytes, row.T);
        BinaryPrimitives.WriteSingleLittleEndian(bytes[8..], (float)row.Y);
        BinaryPrimitives.WriteSingleLittleEndian(bytes[12..], (float)row.D);
        BinaryPrimitives.WriteSingleLittleEndian(bytes[16..], (float)row.E);
        BinaryPrimitives.WriteSingleLittleEndian(bytes[20..], (float)row.G);
        BinaryPrimitives.WriteSingleLittleEndian(bytes[24..], (float)row.B);
        bytes[28] = row.R;
        bytes[29] = row.Gr;
        bytes[30] = row.Bl;
        frames.AddRange(bytes);
    }

    /// <summary>평균 Y·U·V (BT.601 제한 범위) → RGB 0~255</summary>
    private static (byte R, byte G, byte B) Rgb(double y, double u, double v)
    {
        double c = 1.164 * (y - 16), d = u - 128, e = v - 128;
        static byte F(double x) => (byte)Math.Clamp(Math.Round(x, MidpointRounding.ToEven), 0, 255);
        return (F(c + 1.596 * e), F(c - 0.392 * d - 0.813 * e), F(c + 2.017 * d));
    }

    private static string Seconds(double value) => value.ToString("0.000", CultureInfo.InvariantCulture);

    /// <summary>
    /// 베젤 외곽은 화면을 감싸야 한다: 직사각형끼리면 ReplayKit_FailAnalyzer처럼 합쳐 넓히고, 꼭짓점으로 지정한 사각형이 화면을 감싸지 않으면 쓰지 않는다.
    /// 테두리 띠가 너무 얇으면(화면 면적의 3% 미만) 쓰지 않는다
    /// </summary>
    private static Region? FitBezel(Region roi, Region? bezel)
    {
        if (bezel is null)
            return null;
        Region fitted;
        if (roi.IsBox && bezel.IsBox)
        {
            var (a0, b0, a1, b1) = roi.Bounds;
            var (c0, d0, c1, d1) = bezel.Bounds;
            fitted = bezel.WithBox(Math.Min(a0, c0), Math.Min(b0, d0), Math.Max(a1, c1), Math.Max(b1, d1));
        }
        else if (bezel.Contains(roi))
            fitted = bezel;
        else
            return null;
        return fitted.Area - roi.Area > 0.03 * Math.Max(roi.Area, 1e-6) ? fitted : null;
    }

    /// <summary>
    /// 화면·베젤 영역: 영상 크기에 대한 비율 좌표의 네 꼭짓점 (왼쪽 위 · 오른쪽 위 · 오른쪽 아래 · 왼쪽 아래).
    /// 직사각형이면 crop만, 비스듬히 찍혀 사다리꼴이면 둘레 직사각형을 잘라 perspective로 반듯하게 편다 (화면 밖 배경이 섞이지 않게)
    /// </summary>
    private sealed class Region
    {
        public static readonly Region Full = Box(0, 0, 1, 1);
        public readonly double[] X;
        public readonly double[] Y;
        // 꼭짓점 넷(값 8개)으로 받았다 → 돌려줄 때도 그대로 (웹이 꼭짓점을 모르는 옛 에이전트를 알아본다)
        private readonly bool _corners;

        private Region(double[] x, double[] y, bool corners)
        {
            X = x;
            Y = y;
            _corners = corners;
        }

        public static Region Box(double x0, double y0, double x1, double y1, bool corners = false) =>
            new([x0, x1, x1, x0], [y0, y0, y1, y1], corners);

        public Region WithBox(double x0, double y0, double x1, double y1) => Box(x0, y0, x1, y1, _corners);

        /// <summary>[x0, y0, x1, y1] 직사각형 또는 [x, y]×4 꼭짓점. 0~1 밖은 안으로, 너무 작거나 꼬인(볼록하지 않은) 사각형이면 null</summary>
        public static Region? Parse(double[]? values)
        {
            if (values is not { Length: 4 or 8 } || values.Any(v => !double.IsFinite(v)))
                return null;
            var c = values.Select(v => Math.Round(Math.Clamp(v, 0, 1), 4)).ToArray();
            var region = c.Length == 4
                ? Box(Math.Min(c[0], c[2]), Math.Min(c[1], c[3]), Math.Max(c[0], c[2]), Math.Max(c[1], c[3]))
                : new Region([c[0], c[2], c[4], c[6]], [c[1], c[3], c[5], c[7]], true);
            var (x0, y0, x1, y1) = region.Bounds;
            return x1 - x0 >= 0.01 && y1 - y0 >= 0.01 && region.Convex() ? region : null;
        }

        public bool IsBox => Math.Abs(X[0] - X[3]) < 1e-4 && Math.Abs(X[1] - X[2]) < 1e-4
            && Math.Abs(Y[0] - Y[1]) < 1e-4 && Math.Abs(Y[2] - Y[3]) < 1e-4;

        public (double X0, double Y0, double X1, double Y1) Bounds => (X.Min(), Y.Min(), X.Max(), Y.Max());

        /// <summary>넓이 (신발끈 공식)</summary>
        public double Area
        {
            get
            {
                double sum = 0;
                for (var i = 0; i < 4; i++)
                    sum += X[i] * Y[(i + 1) % 4] - X[(i + 1) % 4] * Y[i];
                return Math.Abs(sum) / 2;
            }
        }

        /// <summary>모퉁이마다 꺾는 방향이 같다 (볼록, 꼭짓점 차례가 꼬이지 않음)</summary>
        private bool Convex()
        {
            var sign = 0;
            for (var i = 0; i < 4; i++)
            {
                int j = (i + 1) % 4, k = (i + 2) % 4;
                var cross = (X[j] - X[i]) * (Y[k] - Y[j]) - (Y[j] - Y[i]) * (X[k] - X[j]);
                if (Math.Abs(cross) < 1e-9)
                    return false;
                if (sign == 0)
                    sign = Math.Sign(cross);
                else if (Math.Sign(cross) != sign)
                    return false;
            }
            return true;
        }

        /// <summary>점이 안(경계 포함)에 있다</summary>
        private bool Inside(double x, double y)
        {
            var sign = 0;
            for (var i = 0; i < 4; i++)
            {
                var j = (i + 1) % 4;
                var cross = (X[j] - X[i]) * (y - Y[i]) - (Y[j] - Y[i]) * (x - X[i]);
                if (Math.Abs(cross) < 1e-7)
                    continue;
                if (sign == 0)
                    sign = Math.Sign(cross);
                else if (Math.Sign(cross) != sign)
                    return false;
            }
            return true;
        }

        public bool Contains(Region inner) => Enumerable.Range(0, 4).All(i => Inside(inner.X[i], inner.Y[i]));

        /// <summary>
        /// 바깥(베젤 외곽)과 안(화면) 사이 테두리 띠: 변마다 사다리꼴 [바깥 i, 바깥 i+1, 안 i+1, 안 i] (같은 차례의 꼭짓점끼리).
        /// 넓이가 거의 없거나 꼬인 띠는 뺀다
        /// </summary>
        public static List<Region> Ring(Region outer, Region inner)
        {
            var strips = new List<Region>();
            for (var i = 0; i < 4; i++)
            {
                var j = (i + 1) % 4;
                var strip = new Region([outer.X[i], outer.X[j], inner.X[j], inner.X[i]], [outer.Y[i], outer.Y[j], inner.Y[j], inner.Y[i]], true);
                if (strip.Area > 1e-5 && strip.Convex())
                    strips.Add(strip);
            }
            return strips;
        }

        public double[] ToArray() => _corners || !IsBox
            ? [X[0], Y[0], X[1], Y[1], X[2], Y[2], X[3], Y[3]]
            : [X[0], Y[0], X[2], Y[2]];

        /// <summary>
        /// 이 영역만 남기는 ffmpeg 필터: 둘레 직사각형을 자르고, 사다리꼴이면 perspective로 펴서 그 크기에 채운다
        /// (넓은 영상은 펴기 전에 WarpWidth로 줄인다). videoWidth: 영상 폭 (모르면 0).
        /// inset: 편 뒤 가장자리를 WarpInset만큼 안으로 자른다 (화면을 잴 때, 직사각형은 ReplayKit_FailAnalyzer와 같게 그대로)
        /// </summary>
        public string Filter(int videoWidth, bool inset = false)
        {
            var (x0, y0, x1, y1) = Bounds;
            var crop = string.Create(CultureInfo.InvariantCulture, $"crop=iw*{x1 - x0:0.0000}:ih*{y1 - y0:0.0000}:iw*{x0:0.0000}:ih*{y0:0.0000}");
            if (IsBox)
                return crop;
            var shrink = (x1 - x0) * videoWidth > WarpWidth ? $",scale={WarpWidth}:-2" : "";
            string U(int i) => ((X[i] - x0) / (x1 - x0)).ToString("0.0000", CultureInfo.InvariantCulture);
            string V(int i) => ((Y[i] - y0) / (y1 - y0)).ToString("0.0000", CultureInfo.InvariantCulture);
            // perspective 꼭짓점 차례는 왼쪽 위 · 오른쪽 위 · 왼쪽 아래 · 오른쪽 아래, sense=source: 이 점들을 출력의 네 모서리로
            var trim = inset ? string.Create(CultureInfo.InvariantCulture, $",crop=iw*{1 - 2 * WarpInset:0.00}:ih*{1 - 2 * WarpInset:0.00}:iw*{WarpInset:0.00}:ih*{WarpInset:0.00}") : "";
            return $"{crop}{shrink},perspective=x0={U(0)}*W:y0={V(0)}*H:x1={U(1)}*W:y1={V(1)}*H:x2={U(3)}*W:y2={V(3)}*H:x3={U(2)}*W:y3={V(2)}*H:sense=source{trim}";
        }

        public override string ToString() => string.Join(",", ToArray().Select(v => v.ToString(CultureInfo.InvariantCulture)));
    }

    /// <summary>
    /// 화면 영역 추정: 영상마다 고르게 몇 장 뽑아 칸(8×6)별 윤곽 양의 변화폭이 큰 칸들을 감싸는 사각형.
    /// 배경(케이블·벽)은 화면이 바뀌어도 윤곽 양이 거의 그대로다. 못 찾으면 화면 전체
    /// </summary>
    private static async Task<(Region Roi, string Source)> DetectScreenAsync(string ffmpeg, IReadOnlyList<(string Path, double? Duration)> videos,
        int workers, CancellationToken token)
    {
        var points = videos.SelectMany(v => Enumerable.Range(0, Samples)
            .Select(k => (v.Path, At: v.Duration is { } d ? d * (k + 0.5) / Samples : k * 2.0))).ToList();
        var frames = new ConcurrentBag<byte[]>();
        await Parallel.ForEachAsync(points, new ParallelOptions { MaxDegreeOfParallelism = workers, CancellationToken = token }, async (p, ct) =>
        {
            if (await SampleAsync(ffmpeg, p.Path, p.At, ct) is { } frame)
                frames.Add(frame);
        });
        if (frames.Count < 4)
            return (Region.Full, "화면 전체 (표본 프레임 부족)");
        var lo = new double[GridX * GridY];
        var hi = new double[GridX * GridY];
        Array.Fill(lo, double.MaxValue);
        foreach (var frame in frames)
        {
            var cells = CellEdges(frame);
            for (var i = 0; i < cells.Length; i++)
            {
                lo[i] = Math.Min(lo[i], cells[i]);
                hi[i] = Math.Max(hi[i], cells[i]);
            }
        }
        var range = lo.Select((l, i) => hi[i] - l).ToArray();
        var top = range.Max();
        var dynamic = Enumerable.Range(0, range.Length).Where(i => range[i] >= Math.Max(15, 0.3 * top)).ToList();
        if (dynamic.Count < 4)
            return (Region.Full, "화면 전체 (화면 영역을 찾지 못함)");
        double x0 = dynamic.Min(i => i % GridX) / (double)GridX, x1 = (dynamic.Max(i => i % GridX) + 1) / (double)GridX;
        double y0 = dynamic.Min(i => i / GridX) / (double)GridY, y1 = (dynamic.Max(i => i / GridX) + 1) / (double)GridY;
        if ((x1 - x0) * (y1 - y0) < 0.15)
            return (Region.Full, "화면 전체 (추정 영역이 너무 작음)");
        return (Region.Box(Math.Round(x0, 4), Math.Round(y0, 4), Math.Round(x1, 4), Math.Round(y1, 4)), $"자동 추정 (표본 {frames.Count}장의 칸별 윤곽 변화)");
    }

    /// <summary>at초의 프레임 한 장 (SampleWidth×SampleHeight 회색조). 못 읽으면 null</summary>
    private static async Task<byte[]?> SampleAsync(string ffmpeg, string path, double at, CancellationToken token)
    {
        var info = new ProcessStartInfo(ffmpeg)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };
        foreach (var arg in new[]
                 {
                     "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", Seconds(at), "-i", path, "-frames:v", "1",
                     "-vf", $"scale={SampleWidth}:{SampleHeight},format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-",
                 })
            info.ArgumentList.Add(arg);
        using var process = Process.Start(info);
        if (process is null)
            return null;
        _ = process.StandardError.ReadToEndAsync(CancellationToken.None);
        var frame = new byte[SampleWidth * SampleHeight];
        try
        {
            var read = await process.StandardOutput.BaseStream.ReadAtLeastAsync(frame, frame.Length, throwOnEndOfStream: false, token);
            await process.WaitForExitAsync(token);
            return read == frame.Length ? frame : null;
        }
        finally
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
        }
    }

    /// <summary>칸별 윤곽 양: 이웃(오른쪽·아래) 픽셀과 밝기 차가 EdgeThreshold를 넘는 쌍의 수 × 100 / 칸 픽셀 수</summary>
    private static double[] CellEdges(byte[] px)
    {
        const int cw = SampleWidth / GridX, ch = SampleHeight / GridY;
        var cells = new double[GridX * GridY];
        for (var gy = 0; gy < GridY; gy++)
            for (var gx = 0; gx < GridX; gx++)
            {
                var count = 0;
                for (var y = gy * ch; y < gy * ch + ch; y++)
                {
                    var row = y * SampleWidth + gx * cw;
                    for (var x = 0; x < cw - 1; x++)
                        if (Math.Abs(px[row + x] - px[row + x + 1]) > EdgeThreshold)
                            count++;
                    if (y + 1 < SampleHeight)
                        for (var x = 0; x < cw; x++)
                            if (Math.Abs(px[row + x] - px[row + SampleWidth + x]) > EdgeThreshold)
                                count++;
                }
                cells[gy * GridX + gx] = count * 100.0 / (cw * ch);
            }
        return cells;
    }
}
