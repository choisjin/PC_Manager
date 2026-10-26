using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Numerics;
using PcManager.Shared;

namespace PcManager.Agent;

/// <summary>
/// 결과 확인 도구의 이미지 찾기: ffmpeg로 영상의 모든 프레임을 검색 영역만 잘라 회색조 raw로 읽으며
/// 템플릿(크롭한 이미지)과의 정규화 상관(NCC) 최댓값을 프레임별 유사도로 기록한다. 영상은 이 PC에서 처리해 옮기지 않는다.
/// 검색 영역이 넓으면 줄여서 훑고 후보만 원래 크기로 다시 맞춘다 (Matcher).
/// 웹이 유사도 기준으로 구간을 나누므로 기준을 바꿔도 다시 찾지 않는다
/// </summary>
public class VideoImageSearch(VideoTrimmer trimmer, ILogger<VideoImageSearch> logger)
{
    private const double MaxFps = 60;
    // 한 번에 돌려주는 유사도 (base64로 1.4MB: 서버 SignalR 메시지 한도 2MB를 넘으면 서버가 에이전트 연결을 끊는다. 20시간 60fps 영상은 4MB)
    private const int ChunkBytes = 1_000_000;
    // 끝난 작업은 웹을 닫아도 남긴다 (다시 열면 이어 받는다): 최근 몇 개만, 오래된 것은 버림. 묻는 웹이 없어도 멈추지 않는다 (멈춤은 사용자가)
    private const int KeepFinished = 8;
    private static readonly TimeSpan KeepAge = TimeSpan.FromDays(7);

    /// <summary>영상 하나의 결과. Scores에는 확정된 프레임만 (훑는 중에는 다시 잴 수 있는 마지막 Step개 전까지)</summary>
    private sealed class VideoResult(string path, double fps)
    {
        public readonly string Path = path;
        public readonly double Fps = fps;
        public readonly List<byte> Scores = [];
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
        public int Scale = 1;
        public string? Error;
        public DateTime Finished = DateTime.MaxValue;
    }

    private readonly ConcurrentDictionary<string, Job> _jobs = new();

    public string Start(ImageSearchRequest request)
    {
        Prune();
        var id = Guid.NewGuid().ToString("N");
        var job = new Job();
        _jobs[id] = job;
        _ = Task.Run(async () =>
        {
            try
            {
                await RunAsync(job, request);
                lock (job)
                    job.State = job.Cancel.IsCancellationRequested ? "canceled" : "done";
            }
            catch (OperationCanceledException)
            {
                lock (job)
                    job.State = "canceled";
            }
            catch (Exception ex)
            {
                logger.LogWarning("이미지 찾기 실패: {Message}", ex.Message);
                lock (job)
                {
                    job.State = "failed";
                    job.Error = ex.Message;
                }
            }
            finally
            {
                lock (job)
                {
                    job.Current = null;
                    job.Finished = DateTime.UtcNow;
                }
            }
        });
        return id;
    }

    /// <summary>끝난 작업: 최근 KeepFinished개만, KeepAge보다 오래된 것은 버린다</summary>
    private void Prune()
    {
        var finished = _jobs.Where(kv => kv.Value.Finished != DateTime.MaxValue).OrderByDescending(kv => kv.Value.Finished).ToList();
        foreach (var (key, _) in finished.Skip(KeepFinished).Concat(finished.Where(kv => DateTime.UtcNow - kv.Value.Finished > KeepAge)))
            _jobs.TryRemove(key, out _);
    }

    /// <summary>옛 대시보드: 끝난 영상을 통째로</summary>
    public ImageSearchStatus? Get(string id, int have)
    {
        if (!_jobs.TryGetValue(id, out var job))
            return null;
        lock (job)
        {
            var videos = job.Results.Where(r => r.Done).Skip(Math.Max(0, have))
                .Select(r => new ImageSearchVideo(r.Path, r.Fps, r.Scores.ToArray(), r.Error)).ToList();
            return new ImageSearchStatus(job.State, job.Progress, job.Current, videos, job.Scale, job.Error);
        }
    }

    /// <summary>진행과 video번째 영상의 offset 프레임부터 이어지는 결과 (한 번에 ChunkBytes까지, 훑는 중인 영상은 확정된 프레임까지)</summary>
    public ImageSearchProgress? GetChunks(string id, int video, int offset)
    {
        if (!_jobs.TryGetValue(id, out var job))
            return null;
        lock (job)
        {
            var chunks = new List<ImageSearchChunk>();
            var budget = ChunkBytes;
            var more = false;
            for (var v = Math.Max(0, video); v < job.Results.Count; v++)
            {
                var r = job.Results[v];
                var from = v == video ? Math.Clamp(offset, 0, r.Scores.Count) : 0;
                var count = Math.Min(r.Scores.Count - from, budget);
                var done = r.Done && from + count == r.Scores.Count;
                if (count > 0 || done)
                    chunks.Add(new ImageSearchChunk(v, r.Path, r.Fps, from, r.Scores.GetRange(from, count).ToArray(), done, done ? r.Error : null));
                budget -= count;
                // 영상은 차례로 훑으므로 끝나지 않은 영상 뒤는 아직 없다
                if (!done)
                {
                    more = from + count < r.Scores.Count;
                    break;
                }
                if (budget <= 0)
                {
                    more = v + 1 < job.Results.Count;
                    break;
                }
            }
            return new ImageSearchProgress(job.State, job.Progress, job.Current, job.Scale, job.Error, chunks, more);
        }
    }

    public bool Cancel(string id)
    {
        if (!_jobs.TryGetValue(id, out var job))
            return false;
        job.Cancel.Cancel();
        return true;
    }

    private async Task RunAsync(Job job, ImageSearchRequest r)
    {
        var tw = r.TemplateWidth;
        var th = r.TemplateHeight;
        if (tw < 2 || th < 2 || r.Template.Length != tw * th)
            throw new InvalidOperationException("크롭한 이미지가 너무 작거나 잘못되었습니다.");
        if (r.FrameWidth < tw || r.FrameHeight < th)
            throw new InvalidOperationException("영상 크기를 알 수 없습니다.");
        // 검색 영역: 화면 안으로, 템플릿보다 작으면 템플릿 크기로
        var sx = Math.Clamp(r.SearchX, 0, r.FrameWidth - tw);
        var sy = Math.Clamp(r.SearchY, 0, r.FrameHeight - th);
        var sw = Math.Clamp(r.SearchWidth, tw, r.FrameWidth - sx);
        var sh = Math.Clamp(r.SearchHeight, th, r.FrameHeight - sy);

        var matcher = new Matcher(new Template(r.Template, tw, th), sw, sh);
        lock (job)
            job.Scale = matcher.Scale;

        var ffmpeg = await trimmer.FindFfmpegAsync();
        var probes = new List<VideoTrimmer.Probe?>();
        foreach (var path in r.Paths)
            probes.Add(File.Exists(path) ? await VideoTrimmer.ProbeAsync(ffmpeg, path) : null);
        // 영상마다 훑을 프레임 구간 (영상 전체면 null) · 진행률은 훑을 시간의 합 기준
        var plans = probes.Select((p, i) => FrameRanges(r.Ranges, i, FpsOf(p), p?.Duration)).ToList();
        var seconds = probes.Select((p, i) => p is null ? 0 : plans[i] is { } plan ? plan.Sum(x => x.Count) / FpsOf(p) : p.Duration ?? 60).ToList();
        var total = Math.Max(1, seconds.Sum());
        double before = 0;

        logger.LogInformation("이미지 찾기: 영상 {Count}개 ({Ranges}), 템플릿 {Tw}x{Th}, 영역 {Sw}x{Sh}+{Sx}+{Sy}, 배율 1/{K}, 전체 검색 {Step}프레임마다",
            r.Paths.Count, r.Ranges is null ? "전체" : $"구간 {plans.Sum(p => p?.Count ?? 0)}개 · {total:0}초", tw, th, sw, sh, sx, sy, matcher.Scale, matcher.Step);
        foreach (var (path, index) in r.Paths.Select((p, i) => (p, i)))
        {
            job.Cancel.Token.ThrowIfCancellationRequested();
            var probe = probes[index];
            var fps = FpsOf(probe);
            var result = new VideoResult(path, fps);
            lock (job)
            {
                job.Current = Path.GetFileName(path);
                job.Results.Add(result);
            }
            if (probe is null || plans[index] is { Count: 0 })
            {
                // 파일이 없거나, 고른 스텝이 이 영상에는 없다
                lock (job)
                {
                    result.Error = probe is null ? "영상 파일이 없습니다" : null;
                    result.Done = true;
                }
                continue;
            }

            // fps 필터: 가변 프레임 영상도 프레임 i = i/fps초가 되게 고정 간격으로. 크기가 다른 영상은 크롭한 영상 크기로 맞춘다
            var filter = new List<string> { "fps=" + fps.ToString("0.###", CultureInfo.InvariantCulture) };
            if (probe.Width != r.FrameWidth || probe.Height != r.FrameHeight)
                filter.Add($"scale={r.FrameWidth}:{r.FrameHeight}");
            filter.Add($"crop={sw}:{sh}:{sx}:{sy}");
            filter.Add("format=gray");

            var span = seconds[index];
            var start = before;
            var (scores, error) = await ScanAsync(ffmpeg, path, string.Join(",", filter), matcher, job, result, fps, plans[index], frames =>
            {
                lock (job)
                    job.Progress = Math.Min(1, (start + Math.Min(span, frames / fps)) / total);
            });
            before += span;
            lock (job)
            {
                // 다시 잴 수 있어 남겨 둔 마지막 프레임들까지
                result.Scores.AddRange(scores.Skip(result.Scores.Count));
                result.Error = error;
                result.Done = true;
            }
        }
        lock (job)
            job.Progress = 1;
    }

    /// <summary>영상의 프레임 간격 (가변 프레임 영상도 이 간격으로 고정)</summary>
    private static double FpsOf(VideoTrimmer.Probe? probe) => Math.Min(MaxFps, probe?.Fps ?? 30);

    /// <summary>
    /// 이 영상에서 훑을 프레임 구간 [First, First+Count): 요청 구간(초)을 프레임으로 바꾸고, 겹치거나 1초 안으로 붙은 것은 합친다
    /// (구간마다 ffmpeg를 띄우므로). 구간 요청이 없으면 null = 영상 전체
    /// </summary>
    private static List<(int First, int Count)>? FrameRanges(IReadOnlyList<ImageSearchRange>? ranges, int video, double fps, double? duration)
    {
        if (ranges is null)
            return null;
        var end = duration is { } d ? (int)Math.Ceiling(d * fps) : int.MaxValue;
        var frames = ranges
            .Where(x => x.Video == video)
            .Select(x => (First: Math.Max(0, (int)Math.Floor(x.Start * fps)), Last: Math.Min(end, (int)Math.Ceiling(x.End * fps))))
            .Where(x => x.Last > x.First)
            .OrderBy(x => x.First);
        var gap = (int)Math.Ceiling(fps);
        var merged = new List<(int First, int Count)>();
        foreach (var (first, last) in frames)
        {
            if (merged.Count > 0 && first <= merged[^1].First + merged[^1].Count + gap)
            {
                var (prevFirst, prevCount) = merged[^1];
                merged[^1] = (prevFirst, Math.Max(prevFirst + prevCount, last) - prevFirst);
            }
            else
                merged.Add((first, last - first));
        }
        return merged;
    }

    /// <summary>영상 전체(ranges가 null) 또는 프레임 구간들만 훑는다. 훑지 않은 프레임은 0</summary>
    private async Task<(byte[] Scores, string? Error)> ScanAsync(string ffmpeg, string path, string filter, Matcher matcher, Job job,
        VideoResult result, double fps, List<(int First, int Count)>? ranges, Action<int> progress)
    {
        var scores = new List<byte>();
        string? error = null;
        var scanned = 0;
        foreach (var (first, count) in ranges ?? [(0, -1)])
        {
            while (scores.Count < first)
                scores.Add(0);
            // GPU 디코딩으로 먼저, 한 프레임도 못 읽으면 CPU로 (CPU로는 되면 앞으로 CPU로만)
            var gpu = FfmpegGpu.Decode;
            var (frames, failure) = await ScanRangeAsync(ffmpeg, path, filter, matcher, job, result, fps, first, count, scores, gpu,
                n => progress(scanned + n));
            if (gpu && frames == 0 && failure is not null && !job.Cancel.IsCancellationRequested)
            {
                var gpuError = failure;
                (frames, failure) = await ScanRangeAsync(ffmpeg, path, filter, matcher, job, result, fps, first, count, scores, false,
                    n => progress(scanned + n));
                if (frames > 0)
                    FfmpegGpu.DecodeFailed(logger, gpuError);
            }
            scanned += frames;
            error ??= failure;
            // 끝난 구간은 다시 재지 않는다 → 모두 확정
            lock (job)
            {
                for (var k = result.Scores.Count; k < scores.Count; k++)
                    result.Scores.Add(scores[k]);
            }
        }
        return (scores.ToArray(), scanned == 0 ? error : null);
    }

    /// <summary>
    /// 프레임 first부터 count개(-1이면 끝까지)를 읽어 scores에 이어 쓴다 (부르기 전 scores.Count == first).
    /// 구간이면 ffmpeg가 그 자리로 건너뛰어(앞 키프레임부터 디코딩) 필요한 만큼만 읽는다
    /// </summary>
    private async Task<(int Frames, string? Error)> ScanRangeAsync(string ffmpeg, string path, string filter, Matcher matcher, Job job,
        VideoResult result, double fps, int first, int count, List<byte> scores, bool gpu, Action<int> progress)
    {
        var info = new ProcessStartInfo(ffmpeg)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };
        var args = new List<string> { "-hide_banner", "-loglevel", "error", "-nostdin" };
        if (first > 0)
            args.AddRange(["-ss", Seconds(first / fps)]);
        if (count >= 0)
            args.AddRange(["-t", Seconds(count / fps + 1)]);
        args.AddRange([.. FfmpegGpu.DecodeArgs(gpu), "-i", path, "-an", "-sn", "-dn", "-vf", filter]);
        if (count >= 0)
            args.AddRange(["-frames:v", count.ToString(CultureInfo.InvariantCulture)]);
        args.AddRange(["-f", "rawvideo", "-pix_fmt", "gray", "-"]);
        foreach (var arg in args)
            info.ArgumentList.Add(arg);

        using var process = Process.Start(info) ?? throw new InvalidOperationException("ffmpeg를 시작하지 못했습니다.");
        var errors = process.StandardError.ReadToEndAsync();
        var stdout = process.StandardOutput.BaseStream;
        // 최근 Step개 프레임: 전체 검색에서 새 위치를 찾으면 그 사이 프레임도 그 위치에서 다시 잰다 (첫 프레임을 놓치지 않게)
        var ring = new byte[matcher.Step][];
        var current = matcher.NewPlane();
        var history = matcher.NewPlane();
        (int X, int Y)? last = null;
        var frames = 0;
        try
        {
            for (var i = first; count < 0 || i < first + count; i++)
            {
                var frame = ring[i % matcher.Step] ??= new byte[matcher.Width * matcher.Height];
                var read = await stdout.ReadAtLeastAsync(frame, frame.Length, throwOnEndOfStream: false, job.Cancel.Token);
                if (read < frame.Length)
                    break;
                current.Load(frame);
                double score;
                (int X, int Y) at;
                if (last is null || i % matcher.Step == 0)
                {
                    (score, at) = matcher.Full(current);
                    if (last is { } before && (Math.Abs(before.X - at.X) > matcher.Scale || Math.Abs(before.Y - at.Y) > matcher.Scale))
                        for (var j = i - 1; j >= Math.Max(first, i - matcher.Step + 1); j--)
                        {
                            history.Load(ring[j % matcher.Step]);
                            scores[j] = Math.Max(scores[j], ToByte(matcher.Local(history, at).Score));
                        }
                }
                else
                    (score, at) = matcher.Local(current, last.Value);
                last = at;
                scores.Add(ToByte(score));
                frames++;
                if (frames % 30 == 0)
                {
                    progress(frames);
                    lock (job)
                    {
                        // 위에서 다시 재는 건 마지막 Step개 안쪽뿐 → 그 앞은 확정이라 훑는 중에도 웹이 받아 간다
                        for (var k = result.Scores.Count; k < scores.Count - matcher.Step; k++)
                            result.Scores.Add(scores[k]);
                    }
                }
            }
            // 구간은 -frames:v로 곧 끝나므로 기다리지 않고 정리, 영상 전체는 끝날 때까지
            if (count < 0)
                await process.WaitForExitAsync(job.Cancel.Token);
        }
        finally
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
        }
        progress(frames);
        if (frames > 0)
            return (frames, null);
        await process.WaitForExitAsync();
        if (process.ExitCode == 0)
            return (0, null);
        var tail = string.Join(" ", (await errors).Split('\n', StringSplitOptions.RemoveEmptyEntries).TakeLast(3));
        return (0, $"ffmpeg 실패 (코드 {process.ExitCode}): {tail}");
    }

    private static string Seconds(double value) => value.ToString("0.######", CultureInfo.InvariantCulture);

    private static byte ToByte(double score) => (byte)Math.Round(Math.Clamp(score, 0, 1) * 200);

    /// <summary>회색조 템플릿 + NCC에 쓰는 합·분산</summary>
    private sealed class Template
    {
        public readonly int Width;
        public readonly int Height;
        public readonly byte[] Pixels;
        public readonly long Sum;
        // Σ(T − 평균)²
        public readonly double Norm2;
        // 거의 한 색(표준편차 2 미만)이면 상관을 못 재므로 밝기 차이로 비교
        public readonly bool Flat;

        public Template(byte[] pixels, int width, int height)
        {
            Width = width;
            Height = height;
            Pixels = pixels;
            long sum2 = 0;
            foreach (var p in pixels)
            {
                Sum += p;
                sum2 += p * p;
            }
            Norm2 = sum2 - (double)Sum * Sum / pixels.Length;
            Flat = Norm2 / pixels.Length < 4;
        }

        /// <summary>k배 줄이기 (k×k 칸 평균)</summary>
        public Template Shrink(int k)
        {
            var w = Width / k;
            var h = Height / k;
            var small = new byte[w * h];
            for (var y = 0; y < h; y++)
                for (var x = 0; x < w; x++)
                {
                    var sum = 0;
                    for (var dy = 0; dy < k; dy++)
                        for (var dx = 0; dx < k; dx++)
                            sum += Pixels[(y * k + dy) * Width + x * k + dx];
                    small[y * w + x] = (byte)((sum + k * k / 2) / (k * k));
                }
            return new Template(small, w, h);
        }
    }

    /// <summary>
    /// 프레임(검색 영역) 한 장. 위치를 많이 대 볼 때만 합·제곱합 적분 영상을 만들어 창마다 분산을 바로 구하고,
    /// 몇 군데만 볼 때는(크롭 위치 그대로·직전 위치 둘레) 내적과 함께 바로 더한다 (1080p 전체 적분은 프레임마다 하기엔 무겁다)
    /// </summary>
    private sealed class Plane(int width, int height)
    {
        public readonly int Width = width;
        public readonly int Height = height;
        public byte[] Pixels = new byte[width * height];
        private long[]? _sum;
        private long[]? _sum2;
        private bool _integrated;

        public void Load(byte[] pixels)
        {
            Pixels = pixels;
            _integrated = false;
        }

        public void Integrate()
        {
            var stride = Width + 1;
            _sum ??= new long[stride * (Height + 1)];
            _sum2 ??= new long[stride * (Height + 1)];
            for (var y = 0; y < Height; y++)
            {
                long row = 0, row2 = 0;
                for (var x = 0; x < Width; x++)
                {
                    long v = Pixels[y * Width + x];
                    row += v;
                    row2 += v * v;
                    _sum[(y + 1) * stride + x + 1] = _sum[y * stride + x + 1] + row;
                    _sum2[(y + 1) * stride + x + 1] = _sum2[y * stride + x + 1] + row2;
                }
            }
            _integrated = true;
        }

        /// <summary>source를 k배 줄여 담는다 (k×k 칸 평균)</summary>
        public void Shrink(Plane source, int k)
        {
            for (var y = 0; y < Height; y++)
                for (var x = 0; x < Width; x++)
                {
                    var sum = 0;
                    for (var dy = 0; dy < k; dy++)
                    {
                        var o = (y * k + dy) * source.Width + x * k;
                        for (var dx = 0; dx < k; dx++)
                            sum += source.Pixels[o + dx];
                    }
                    Pixels[y * Width + x] = (byte)((sum + k * k / 2) / (k * k));
                }
            Integrate();
        }

        /// <summary>(x, y)에 템플릿을 대 본 유사도 (NCC, 한 색 템플릿이면 밝기 차이) −1~1</summary>
        public double Score(Template t, int px, int py)
        {
            var n = t.Pixels.Length;
            if (t.Flat)
            {
                long diff = 0;
                for (var y = 0; y < t.Height; y++)
                {
                    var f = Pixels.AsSpan((py + y) * Width + px, t.Width);
                    var o = t.Pixels.AsSpan(y * t.Width, t.Width);
                    for (var x = 0; x < o.Length; x++)
                        diff += Math.Abs(f[x] - o[x]);
                }
                return 1 - diff / (255.0 * n);
            }
            long dot = 0, sum = 0, sum2 = 0;
            for (var y = 0; y < t.Height; y++)
                Accumulate(t.Pixels.AsSpan(y * t.Width, t.Width), Pixels.AsSpan((py + y) * Width + px, t.Width),
                    ref dot, ref sum, ref sum2, !_integrated);
            if (_integrated)
            {
                var stride = Width + 1;
                long R(long[] s) => s[(py + t.Height) * stride + px + t.Width] - s[py * stride + px + t.Width]
                    - s[(py + t.Height) * stride + px] + s[py * stride + px];
                sum = R(_sum!);
                sum2 = R(_sum2!);
            }
            var variance = sum2 - (double)sum * sum / n;
            // 거의 한 색인 곳에는 무늬 있는 템플릿이 없다
            if (variance < 4.0 * n)
                return 0;
            // Σ(T − T평균)·W = ΣT·W − T평균·ΣW
            return (dot - (double)t.Sum * sum / n) / Math.Sqrt(t.Norm2 * variance);
        }

        /// <summary>한 줄의 ΣT·W (sums면 ΣW·ΣW²도). 정수 SIMD: 바이트 곱은 ushort에 들어간다 (255² &lt; 65536)</summary>
        private static void Accumulate(ReadOnlySpan<byte> t, ReadOnlySpan<byte> w, ref long dot, ref long sum, ref long sum2, bool sums)
        {
            var i = 0;
            if (Vector.IsHardwareAccelerated && t.Length >= Vector<byte>.Count)
            {
                var vDot = Vector<uint>.Zero;
                var vSum = Vector<uint>.Zero;
                var vSum2 = Vector<uint>.Zero;
                for (; i <= t.Length - Vector<byte>.Count; i += Vector<byte>.Count)
                {
                    Vector.Widen(new Vector<byte>(t[i..]), out var t0, out var t1);
                    Vector.Widen(new Vector<byte>(w[i..]), out var w0, out var w1);
                    Vector.Widen(t0 * w0, out var a, out var b);
                    Vector.Widen(t1 * w1, out var c, out var d);
                    vDot += a + b + c + d;
                    if (!sums)
                        continue;
                    Vector.Widen(w0 + w1, out var s0, out var s1);
                    vSum += s0 + s1;
                    Vector.Widen(w0 * w0, out var q0, out var q1);
                    Vector.Widen(w1 * w1, out var q2, out var q3);
                    vSum2 += q0 + q1 + q2 + q3;
                }
                dot += Vector.Sum(vDot);
                sum += Vector.Sum(vSum);
                sum2 += Vector.Sum(vSum2);
            }
            for (; i < t.Length; i++)
            {
                int v = w[i];
                dot += t[i] * v;
                if (!sums)
                    continue;
                sum += v;
                sum2 += v * v;
            }
        }
    }

    /// <summary>
    /// 검색 영역에서 템플릿 찾기. 영역이 넓으면 1/Scale로 줄여 모든 위치를 훑은 뒤 상위 후보를 원래 크기에서 다시 맞춘다.
    /// 그래도 계산이 많으면 Step 프레임마다만 전체 검색하고, 그 사이 프레임은 직전 위치 둘레만 본다 (아이콘은 보통 제자리)
    /// </summary>
    private sealed class Matcher
    {
        // 프레임당 계산량 상한 (위치 수 × 템플릿 픽셀 수) · 줄인 템플릿의 최소 변 · 전체 검색 간격 상한 · 다시 맞춰 볼 후보 수 · 따라가기 반경
        private const long Budget = 1_000_000;
        private const int MinCoarseSide = 10;
        private const int MaxStep = 15;
        private const int Candidates = 3;
        private const int TrackRadius = 2;

        public readonly int Width;
        public readonly int Height;
        public readonly int Scale;
        public readonly int Step;
        private readonly Template _template;
        private readonly Template? _coarse;
        private readonly Plane? _small;

        public Matcher(Template template, int width, int height)
        {
            _template = template;
            Width = width;
            Height = height;
            long Cost(int s) => (long)(width / s - template.Width / s + 1) * (height / s - template.Height / s + 1)
                * (template.Width / s) * (template.Height / s);
            var k = 1;
            while (Cost(k) > Budget && Math.Min(template.Width, template.Height) / (k + 1) >= MinCoarseSide)
                k++;
            Scale = k;
            Step = (int)Math.Clamp((Cost(k) + Budget - 1) / Budget, 1, MaxStep);
            if (k > 1)
            {
                _coarse = template.Shrink(k);
                _small = new Plane(width / k, height / k);
            }
        }

        public Plane NewPlane() => new(Width, Height);

        /// <summary>영역 전체에서 가장 높은 유사도와 그 위치</summary>
        public (double Score, (int X, int Y) At) Full(Plane plane)
        {
            if (_coarse is null || _small is null)
                return Exhaustive(plane, _template);
            _small.Shrink(plane, Scale);
            var cols = _small.Width - _coarse.Width + 1;
            var rows = _small.Height - _coarse.Height + 1;
            var map = new double[cols * rows];
            Parallel.For(0, rows, y =>
            {
                for (var x = 0; x < cols; x++)
                    map[y * cols + x] = _small.Score(_coarse, x, y);
            });
            // 상위 후보 (서로 템플릿 반 크기 이상 떨어진 것)를 원래 크기에서 다시 맞춘다.
            // 줄인 칸 (cx, cy)는 원래 위치 cx·Scale ± Scale/2 쯤 (줄일 때 칸 경계가 어긋난 만큼)
            var best = (Score: double.MinValue, At: (X: 0, Y: 0));
            var rx = Math.Max(1, _coarse.Width / 2);
            var ry = Math.Max(1, _coarse.Height / 2);
            for (var c = 0; c < Candidates; c++)
            {
                var top = -1;
                for (var i = 0; i < map.Length; i++)
                    if (map[i] > double.MinValue && (top < 0 || map[i] > map[top]))
                        top = i;
                if (top < 0)
                    break;
                int cx = top % cols, cy = top / cols;
                for (var y = Math.Max(0, cy - ry); y <= Math.Min(rows - 1, cy + ry); y++)
                    for (var x = Math.Max(0, cx - rx); x <= Math.Min(cols - 1, cx + rx); x++)
                        map[y * cols + x] = double.MinValue;
                var refined = Local(plane, (cx * Scale, cy * Scale), Scale / 2 + 1);
                if (refined.Score > best.Score)
                    best = refined;
            }
            return best;
        }

        /// <summary>원래 크기에서 around 둘레 radius만 (줄여 훑은 오차 · 프레임 사이 흔들림)</summary>
        public (double Score, (int X, int Y) At) Local(Plane plane, (int X, int Y) around, int radius = TrackRadius)
        {
            var x0 = Math.Max(0, around.X - radius);
            var x1 = Math.Min(Width - _template.Width, around.X + radius);
            var y0 = Math.Max(0, around.Y - radius);
            var y1 = Math.Min(Height - _template.Height, around.Y + radius);
            var rowBest = new (double Score, int X)[y1 - y0 + 1];
            void Row(int y)
            {
                var best = (Score: double.MinValue, X: x0);
                for (var x = x0; x <= x1; x++)
                {
                    var s = plane.Score(_template, x, y);
                    if (s > best.Score)
                        best = (s, x);
                }
                rowBest[y - y0] = best;
            }
            // 큰 템플릿이면 줄마다 나눠 계산
            if ((long)rowBest.Length * (x1 - x0 + 1) * _template.Pixels.Length > 200_000)
                Parallel.For(y0, y1 + 1, Row);
            else
                for (var y = y0; y <= y1; y++)
                    Row(y);
            var row = 0;
            for (var i = 1; i < rowBest.Length; i++)
                if (rowBest[i].Score > rowBest[row].Score)
                    row = i;
            return (rowBest[row].Score, (rowBest[row].X, y0 + row));
        }

        private static (double Score, (int X, int Y) At) Exhaustive(Plane plane, Template t)
        {
            var cols = plane.Width - t.Width + 1;
            var rows = plane.Height - t.Height + 1;
            if (cols * rows == 1)
                return (plane.Score(t, 0, 0), (0, 0));
            plane.Integrate();
            var rowBest = new (double Score, int X)[rows];
            Parallel.For(0, rows, y =>
            {
                var best = (Score: double.MinValue, X: 0);
                for (var x = 0; x < cols; x++)
                {
                    var s = plane.Score(t, x, y);
                    if (s > best.Score)
                        best = (s, x);
                }
                rowBest[y] = best;
            });
            var row = 0;
            for (var y = 1; y < rows; y++)
                if (rowBest[y].Score > rowBest[row].Score)
                    row = y;
            return (rowBest[row].Score, (rowBest[row].X, row));
        }
    }
}
