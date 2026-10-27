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
    /// <summary>
    /// 화면 깨짐 비교용 축소 이미지: 화면 영역을 ThumbW×ThumbH 회색으로 줄인 것을 ThumbSeconds마다 하나 (시각 double + 화소 ThumbW×ThumbH바이트).
    /// 웹이 기준 Cycle의 같은 자리와 칸별로 견준다 (밝기·평균 색·윤곽 요약으로는 화면 일부만 깨진 것이 보이지 않아서)
    /// </summary>
    public const int ThumbW = 16;
    public const int ThumbH = 9;
    public const int ThumbBytes = 8 + ThumbW * ThumbH;
    private const double ThumbSeconds = 0.2;
    // 한 번에 돌려주는 크기 (프레임 + 축소 이미지, base64로 1.4MB: 서버 SignalR 메시지 한도 2MB를 넘으면 서버가 에이전트 연결을 끊는다)
    private const int ChunkBytes = 1_000_000;
    // 구간 길이: 첫 두 구간은 1/4·1/2로 작게(첫 결과가 빨리), 10구간 길이 뒤부터는 5배(ffmpeg 실행 횟수를 줄임)
    private const double ChunkSeconds = 60;
    // 구간마다 이만큼 앞에서 시작해 탐색 직후의 덜 준비된 프레임은 버린다 (첫 프레임의 프레임 차이도 앞 프레임과 비교되게)
    private const double Lead = 1.0;
    // 동시에 돌리는 ffmpeg 수 · ffmpeg 하나의 필터 스레드 수. 측정 필터(펴기·통계·윤곽)는 프레임마다 차례로 돌아 ffmpeg 하나로는 코어를
    // 다 못 쓰므로 여러 구간을 동시에 재고, 필터 스레드는 코어를 나눠 준다 (기본값은 ffmpeg마다 코어 수만큼이라 넘친다).
    // 측정(1080p 2분, 꼭짓점 영역): 16스레드에서 4개·기본 → 8개·2개로 CPU 디코딩 21%·GPU 디코딩 13% 빠름, 24스레드(8개·3개) 19%·7%
    private static readonly int Workers = Math.Clamp(Environment.ProcessorCount / 2, 1, 8);
    private static readonly int FilterThreads = Math.Clamp(Environment.ProcessorCount / Workers, 1, 3);
    // 사다리꼴 영역은 펴기 전에 이 폭으로 줄인다 (어차피 320 폭으로 잰다)
    private const int WarpWidth = 640;
    // 편 화면은 가장자리를 이만큼(양쪽 3%) 안으로 잘라 잰다: 꼭짓점이 조금만 어긋나도 남는 배경 띠의 경계가 윤곽으로 잡혀
    // 꺼진 화면을 켜진 것으로 보지 않게
    private const double WarpInset = 0.03;
    // 끝난 작업은 웹을 닫아도 남긴다 (다시 열면 이어 받는다): 프레임 값이 커서(20시간 30fps ≈ 67MB) 끝난 것은 최근 몇 개만, 오래된 것은 버림.
    // 묻는 웹이 없어도 멈추지 않는다 (멈춤은 사용자가)
    private const int KeepFinished = 4;
    private static readonly TimeSpan KeepAge = TimeSpan.FromDays(7);

    private sealed class VideoResult(string path)
    {
        public readonly string Path = path;
        // 앞에서부터 이어 붙인 프레임 (FrameBytes씩)
        public readonly List<byte> Frames = [];
        // 구간이 하나 끝날 때마다의 프레임 수 (웹이 이 경계마다 판정한다: ReplayKit_FailAnalyzer와 같은 기준값 창)
        public readonly List<int> Marks = [];
        // 축소 이미지 (ThumbBytes씩, 시각순) · 그 시각 (프레임 범위에 드는 것을 찾을 때)
        public readonly List<byte> Thumbs = [];
        public readonly List<double> ThumbTimes = [];
        public bool Done;
        public string? Error;
    }

    /// <summary>구간 하나를 잰 결과: 프레임별 측정값 · 축소 이미지 (시각, 화소)</summary>
    private sealed record Measured(List<Row> Rows, List<(double T, byte[] Pixels)> Thumbs);

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
    }

    /// <summary>프레임 한 장의 측정값 (T: 영상 안 초)</summary>
    private readonly record struct Row(double T, double Y, double D, double E, double G, double B, byte R, byte Gr, byte Bl);

    private readonly ConcurrentDictionary<string, Job> _jobs = new();

    public string Start(VideoAnalysisRequest request)
    {
        Prune();
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

    /// <summary>
    /// 진행과 video번째 영상의 offset 프레임부터 이어지는 결과 (한 번에 ChunkBytes까지, 재는 중인 영상은 앞에서부터 이어진 부분까지).
    /// 축소 이미지는 보내는 프레임들의 시각 안에 든 것을 함께 보낸다
    /// </summary>
    public VideoAnalysisProgress? GetChunks(string id, int video, int offset)
    {
        if (!_jobs.TryGetValue(id, out var job))
            return null;
        lock (job)
        {
            var chunks = new List<VideoAnalysisChunk>();
            var budget = ChunkBytes;
            var more = false;
            for (var v = Math.Max(0, video); v < job.Results.Count; v++)
            {
                var r = job.Results[v];
                var have = r.Frames.Count / FrameBytes;
                var from = v == video ? Math.Clamp(offset, 0, have) : 0;
                var count = Math.Min(have - from, budget / FrameBytes);
                var (first, thumbs) = ThumbRange(r, from, count);
                // 축소 이미지까지 넣어 예산을 넘으면 프레임을 줄인다
                while (count > 0 && count * FrameBytes + thumbs * ThumbBytes > budget)
                {
                    count = count * 4 / 5;
                    (first, thumbs) = ThumbRange(r, from, count);
                }
                var done = r.Done && from + count == have;
                if (count > 0 || done)
                    chunks.Add(new VideoAnalysisChunk(v, r.Path, from,
                        CollectionsMarshal.AsSpan(r.Frames).Slice(from * FrameBytes, count * FrameBytes).ToArray(),
                        r.Marks.Where(m => m > from && m <= from + count).ToArray(), done, done ? r.Error : null,
                        thumbs > 0 ? CollectionsMarshal.AsSpan(r.Thumbs).Slice(first * ThumbBytes, thumbs * ThumbBytes).ToArray() : null));
                budget -= count * FrameBytes + thumbs * ThumbBytes;
                // 영상은 차례로 재므로 끝나지 않은 영상 뒤는 아직 없다
                if (!done)
                {
                    more = from + count < have;
                    break;
                }
                if (budget < FrameBytes + ThumbBytes)
                {
                    more = v + 1 < job.Results.Count;
                    break;
                }
            }
            return new VideoAnalysisProgress(job.State, job.Progress, job.Current, job.Error, job.Roi, job.RoiSource, job.Bezel, chunks, more);
        }
    }

    /// <summary>프레임 [from, from+count)의 시각 안에 든 축소 이미지: 첫 차례와 개수</summary>
    private static (int First, int Count) ThumbRange(VideoResult r, int from, int count)
    {
        if (count <= 0 || r.ThumbTimes.Count == 0)
            return (0, 0);
        var frames = CollectionsMarshal.AsSpan(r.Frames);
        var t0 = BinaryPrimitives.ReadDoubleLittleEndian(frames.Slice(from * FrameBytes, 8));
        var t1 = BinaryPrimitives.ReadDoubleLittleEndian(frames.Slice((from + count - 1) * FrameBytes, 8));
        // 첫 조각은 앞에 남은 것까지 (프레임이 빠진 축소 이미지)
        var first = from == 0 ? 0 : LowerBound(r.ThumbTimes, t0 - 1e-6);
        var end = LowerBound(r.ThumbTimes, t1 + 1e-6);
        return (first, Math.Max(0, end - first));
    }

    /// <summary>정렬된 values에서 x 이상인 첫 차례</summary>
    private static int LowerBound(List<double> values, double x)
    {
        int lo = 0, hi = values.Count;
        while (lo < hi)
        {
            var mid = (lo + hi) / 2;
            if (values[mid] < x)
                lo = mid + 1;
            else
                hi = mid;
        }
        return lo;
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
        // 동시에 돌리는 ffmpeg 수 (Workers 참고)
        var workers = Workers;
        // 영상마다 재기 시작할 초 (테스트 시작 전은 재지 않음) · 그 영상을 통째로 건너뛰는지 (테스트 시작 전에 끝난 영상)
        var froms = r.Paths.Select((_, i) => Math.Max(0, r.Starts is { } s && i < s.Length && double.IsFinite(s[i]) ? s[i] : 0)).ToArray();
        bool Skipped(int i) => probes[i]?.Duration is { } d && froms[i] >= d - 0.05;

        // 화면 영역: 웹에서 직접 지정한 것 (없으면 화면 전체). 베젤은 화면을 지정했을 때만
        var given = Region.Parse(r.Roi);
        var roi = given ?? Region.Full;
        var source = roi.IsBox && roi.Bounds == (0d, 0d, 1d, 1d) ? "화면 전체" : "직접 지정";
        var bezel = given is not null ? FitBezel(roi, Region.Parse(r.Bezel)) : null;
        lock (job)
        {
            job.Roi = roi.ToArray();
            job.RoiSource = source;
            job.Bezel = bezel?.ToArray();
        }
        logger.LogInformation("영상 분석: 영상 {Count}개, 화면 영역 {Roi} ({Source}), 베젤 {Bezel}, ffmpeg {Workers}개",
            r.Paths.Count, roi, source, bezel?.ToString() ?? "없음", workers);

        var total = Math.Max(1, probes.Select((p, i) => Math.Max(0, (p?.Duration ?? 0) - froms[i])).Sum());
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
            // 테스트 시작 전에 끝난 영상: 재지 않고 빈 결과로 끝낸다
            if (Skipped(index))
            {
                lock (job)
                    result.Done = true;
                continue;
            }
            var start = before;
            var from = froms[index];
            try
            {
                await MeasureVideoAsync(ffmpeg, path, probe.Duration, from, probe.Width, probe.Height, probe.Codec, roi, bezel, workers, job, result, seconds =>
                {
                    lock (job)
                        job.Progress = Math.Min(1, (start + seconds - from) / total);
                });
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning("영상 분석 실패 {Path}: {Message}", path, ex.Message);
                lock (job)
                    result.Error = ex.Message;
            }
            before += Math.Max(0, (probe.Duration ?? 0) - from);
            lock (job)
                result.Done = true;
        }
        lock (job)
            job.Progress = 1;
    }

    /// <summary>영상 하나 (from초부터): 구간마다 ffmpeg를 돌리되 모든 작업자가 앞 구간부터 가져가고, 결과는 앞에서부터 차례로 붙인다</summary>
    private async Task MeasureVideoAsync(string ffmpeg, string path, double? duration, double from, int width, int height, string? codec,
        Region roi, Region? bezel, int workers, Job job, VideoResult result, Action<double> progress)
    {
        var bounds = Chunks(duration ?? 0, from);
        var outputs = bounds.Select(_ => new TaskCompletionSource<Measured>(TaskCreationOptions.RunContinuationsAsynchronously)).ToArray();
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(job.Cancel.Token);
        var next = -1;
        async Task Work()
        {
            for (var i = Interlocked.Increment(ref next); i < bounds.Count; i = Interlocked.Increment(ref next))
            {
                try
                {
                    outputs[i].TrySetResult(await MeasureAsync(ffmpeg, path, roi, bezel, width, height, codec, bounds[i].Start, bounds[i].Length, stop.Token));
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
        // 마지막으로 붙인 축소 이미지 시각: 칸(ThumbSeconds)은 ffmpeg가 골랐으니 다시 나누지 않고 구간 경계에서 거의 겹친 것만 뺀다
        // (C#에서 시각을 칸 크기로 나누면 소수 오차로 ffmpeg와 칸이 달라져 멀쩡한 것까지 빠진다)
        var lastThumb = double.NegativeInfinity;
        try
        {
            for (var i = 0; i < bounds.Count; i++)
            {
                var (rows, thumbs) = await outputs[i].Task.WaitAsync(stop.Token);
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
                    foreach (var (t, pixels) in thumbs)
                    {
                        if (t < lastThumb + ThumbSeconds / 2)
                            continue;
                        lastThumb = t;
                        var time = new byte[8];
                        BinaryPrimitives.WriteDoubleLittleEndian(time, t);
                        result.Thumbs.AddRange(time);
                        result.Thumbs.AddRange(pixels);
                        result.ThumbTimes.Add(t);
                    }
                    result.Marks.Add(result.Frames.Count / FrameBytes);
                    // 마지막 구간은 끝남과 함께 (웹이 마지막 판정을 한 번에 닫게)
                    if (i == bounds.Count - 1)
                        result.Done = true;
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

    /// <summary>
    /// 영상 구간 (from초부터): 앞은 작게(1/4 → 1/2 → 1) 잘라 첫 결과가 빨리 나오게, 뒤로 가면 크게. 길이를 모르면 from부터 통째로 하나
    /// </summary>
    private static List<(double Start, double? Length)> Chunks(double total, double from)
    {
        var bounds = new List<(double, double?)>();
        var pos = from;
        for (var k = 0; total - pos > 0.05; k++)
        {
            var size = k switch
            {
                0 => ChunkSeconds / 4,
                1 => ChunkSeconds / 2,
                _ => pos - from < 10 * ChunkSeconds ? ChunkSeconds : 5 * ChunkSeconds,
            };
            bounds.Add((pos, Math.Min(size, total - pos)));
            pos += size;
        }
        return bounds.Count > 0 ? bounds : [(from, null)];
    }

    /// <summary>
    /// [start, start+length) 구간 프레임들의 측정값과 축소 이미지. 밝기·차이·평균 색은 stdout, 윤곽·칸 윤곽·베젤 외곽·축소 이미지는 작업 폴더의
    /// 파일로 받는다 (윈도우 경로의 ':'를 필터 문법에서 피하려고 작업 폴더 안의 상대 경로). width·height: 영상 크기 (사다리꼴을 펴기 전에
    /// 줄일지 · GPU에서 자를 픽셀), codec: 영상 코덱 (NVIDIA cuvid 디코더를 고를 때)
    /// </summary>
    private async Task<Measured> MeasureAsync(string ffmpeg, string path, Region roi, Region? bezel, int width, int height, string? codec,
        double start, double? length, CancellationToken token)
    {
        // GPU 디코딩으로 먼저 (NVIDIA는 GPU에서 영역을 잘라 줄이기까지, 외장 → 내장), 안 되면 이 영상만 CPU로.
        // GPU에서 자르면 화면 전체가 없으므로 베젤(화면 밖 띠)을 잴 때는 쓰지 않는다
        var cuvid = bezel is null && FfmpegGpu.CuvidDecoder(codec) is not null && width > 0 && height > 0;
        return await FfmpegGpu.DecodeAsync(logger, path,
            decode => MeasureOnceAsync(ffmpeg, path, roi, bezel, width, height, codec, start, length, decode, token), _ => null, cuvid);
    }

    /// <summary>MeasureAsync 한 번 (decode: GPU 디코딩 방법, null이면 CPU)</summary>
    private static async Task<Measured> MeasureOnceAsync(string ffmpeg, string path, Region roi, Region? bezel, int width, int height, string? codec,
        double start, double? length, FfmpegGpu.DecodeOption? decode, CancellationToken token)
    {
        var folder = Directory.CreateTempSubdirectory("pcm_va_");
        try
        {
            var seek = Math.Max(start - Lead, 0);
            var end = length is { } l ? start + l : double.PositiveInfinity;
            var threads = FilterThreads.ToString(CultureInfo.InvariantCulture);
            var args = new List<string> { "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-filter_threads", threads, "-filter_complex_threads", threads };
            if (start > 0)
                args.AddRange(["-ss", Seconds(seek)]);
            if (length is { } span)
                args.AddRange(["-t", Seconds(span + (start - seek))]);
            // 화면 영역: NVIDIA cuvid면 디코더가 외접 사각형을 잘라 펴기 전 크기로 줄여 내보내고(-crop·-resize) CPU는 펴기만,
            // 아니면 CPU가 자르고 줄이고 편다
            string[] input;
            string region;
            if (decode is { Kind: FfmpegGpu.DecodeKind.Cuvid } && FfmpegGpu.CuvidDecoder(codec) is { } decoder)
            {
                var (crop, resize) = roi.GpuCrop(width, height);
                input = ["-c:v", decoder, "-gpu", decode.CudaIndex.ToString(CultureInfo.InvariantCulture), "-crop", crop, "-resize", resize];
                region = roi.WarpFilter(inset: true);
            }
            else
            {
                input = decode?.Args ?? [];
                region = roi.Filter(width, inset: true);
            }
            // 화면 영역을 320 폭으로 줄여 둘로 나눈다: 측정 (밝기·차이·평균 색 → stdout, 윤곽 → edge.txt, 가장 많은 칸 → grid.txt) ·
            // 축소 이미지 (ThumbSeconds 칸마다 첫 프레임만 ThumbW×ThumbH 회색으로 → thumb.raw, 그 시각 → thumb.txt)
            var bin = Seconds(ThumbSeconds);
            var main = $"{region},scale=320:-2,split=2[m][t];"
                + "[m]signalstats,metadata=print:file=-,"
                + "edgedetect=low=0.08:high=0.2,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=edge.txt,"
                + "scale=8:4:flags=area,signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=grid.txt[out];"
                + $"[t]select='isnan(prev_selected_t)+gt(floor(t/{bin}+0.0001),floor(prev_selected_t/{bin}+0.0001))',"
                + $"scale={ThumbW}:{ThumbH}:flags=area,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=thumb.txt,format=gray[thumb]";
            args.AddRange([.. input, "-copyts", "-i", path]);
            // 베젤 테두리 띠: 직사각형끼리면 외곽 전체를 재서 화면을 빼고 (ReplayKit_FailAnalyzer와 같게),
            // 꼭짓점이면 변마다 사다리꼴 띠 넷을 각각 펴서 재고 넓이로 평균한다 (얇은 띠에서 빼기의 오차가 커지지 않게)
            var boxRing = bezel is not null && roi.IsBox && bezel.IsBox;
            List<Region> strips = bezel is null ? [] : boxRing ? [bezel] : Region.Ring(bezel, roi);
            var graph = new StringBuilder();
            if (strips.Count > 0)
            {
                graph.Append($"[0:v]split={strips.Count + 1}[a]");
                for (var k = 0; k < strips.Count; k++)
                    graph.Append($"[r{k}]");
                graph.Append($";[a]{main}");
                for (var k = 0; k < strips.Count; k++)
                    graph.Append($";[r{k}]{strips[k].Filter(width)},scale={(boxRing ? "160:-2" : "64:16")},signalstats,"
                        + $"metadata=print:key=lavfi.signalstats.YAVG:file=ring{k}.txt,nullsink");
            }
            else
                graph.Append($"[0:v]{main}");
            args.AddRange(["-filter_complex", graph.ToString(),
                "-map", "[out]", "-fps_mode", "passthrough", "-an", "-sn", "-dn", "-f", "null", "-",
                "-map", "[thumb]", "-fps_mode", "passthrough", "-f", "rawvideo", "thumb.raw"]);

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
            // GPU 디코딩(strict)은 오류로 끝나면 프레임이 있어도 실패로 → 다음 GPU·CPU로 이 구간을 다시 (GPU 디코더는 깨진 패킷에서 멈추기도 한다).
            // 마지막 시도인 CPU는 거기까지 잰 것이라도 쓴다
            var strict = decode is not null;
            if (process.ExitCode != 0 && (luma.Count == 0 || strict))
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
            // GPU 디코더가 중간에 멈춰도 ffmpeg가 0으로 끝나기도 한다: 구간 앞 절반도 못 채웠으면 실패로 (가변 프레임 영상의 긴 빈틈은 넘기게 절반까지만)
            if (strict && length is { } chunk && rows.Count > 0 && rows[^1].T < start + chunk / 2 - 1)
                throw new FfmpegGpu.DecodeIncompleteException($"GPU 디코딩이 구간 중간({rows[^1].T:0.0}초, 구간 {start:0.0}~{end:0.0}초)에서 멈췄습니다");
            return new Measured(rows, ReadThumbs(folder.FullName, start, end));
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

    /// <summary>
    /// 축소 이미지: thumb.raw(ThumbW×ThumbH바이트씩)와 같은 차례로 thumb.txt에 찍힌 시각을 짝지어 [start, end) 안의 것만 (시각순).
    /// 끝이 잘려 개수가 다르면 둘 다 있는 데까지
    /// </summary>
    private static List<(double T, byte[] Pixels)> ReadThumbs(string folder, double start, double end)
    {
        var thumbs = new List<(double, byte[])>();
        var raw = Path.Combine(folder, "thumb.raw");
        var txt = Path.Combine(folder, "thumb.txt");
        if (!File.Exists(raw) || !File.Exists(txt))
            return thumbs;
        var times = new List<double>();
        foreach (var line in File.ReadLines(txt))
            if (PtsTime(line) is { } t)
                times.Add(t);
        const int size = ThumbW * ThumbH;
        using var stream = File.OpenRead(raw);
        var count = (int)Math.Min(stream.Length / size, times.Count);
        for (var i = 0; i < count; i++)
        {
            var pixels = new byte[size];
            stream.ReadExactly(pixels);
            if (times[i] >= start - 1e-6 && times[i] < end)
                thumbs.Add((times[i], pixels));
        }
        return thumbs;
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
            return $"{crop}{shrink},{WarpFilter(inset)}";
        }

        /// <summary>
        /// 외접 사각형으로 잘라 놓은 프레임을 반듯하게 펴는 필터 (Filter의 뒷부분, 직사각형이면 할 일이 없어 null).
        /// perspective 꼭짓점 차례는 왼쪽 위 · 오른쪽 위 · 왼쪽 아래 · 오른쪽 아래, sense=source: 이 점들을 출력의 네 모서리로
        /// </summary>
        public string WarpFilter(bool inset = false)
        {
            if (IsBox)
                return "null";
            var (x0, y0, x1, y1) = Bounds;
            string U(int i) => ((X[i] - x0) / (x1 - x0)).ToString("0.0000", CultureInfo.InvariantCulture);
            string V(int i) => ((Y[i] - y0) / (y1 - y0)).ToString("0.0000", CultureInfo.InvariantCulture);
            var trim = inset ? string.Create(CultureInfo.InvariantCulture, $",crop=iw*{1 - 2 * WarpInset:0.00}:ih*{1 - 2 * WarpInset:0.00}:iw*{WarpInset:0.00}:ih*{WarpInset:0.00}") : "";
            return $"perspective=x0={U(0)}*W:y0={V(0)}*H:x1={U(1)}*W:y1={V(1)}*H:x2={U(3)}*W:y2={V(3)}*H:x3={U(2)}*W:y3={V(2)}*H:sense=source{trim}";
        }

        /// <summary>
        /// NVIDIA cuvid 디코더가 GPU에서 할 자르기·줄이기 (Filter의 crop·scale과 같은 일): -crop 위x아래x왼쪽x오른쪽 (픽셀, 짝수) ·
        /// -resize 폭x높이 — 꼭짓점이면 펴기 전 크기(WarpWidth보다 넓을 때만 줄임), 직사각형이면 바로 잴 크기(320폭)
        /// </summary>
        public (string Crop, string Resize) GpuCrop(int width, int height)
        {
            var (x0, y0, x1, y1) = Bounds;
            static int Even(double v) => (int)Math.Round(v / 2) * 2;
            var left = Math.Clamp(Even(x0 * width), 0, width - 2);
            var top = Math.Clamp(Even(y0 * height), 0, height - 2);
            var right = Math.Clamp(width - Even(x1 * width), 0, width - left - 2);
            var bottom = Math.Clamp(height - Even(y1 * height), 0, height - top - 2);
            var w = width - left - right;
            var h = height - top - bottom;
            var outW = IsBox ? 320 : Math.Min(w, WarpWidth) / 2 * 2;
            var outH = Math.Max(2, Even((double)h * outW / w));
            return (string.Create(CultureInfo.InvariantCulture, $"{top}x{bottom}x{left}x{right}"),
                string.Create(CultureInfo.InvariantCulture, $"{outW}x{outH}"));
        }

        public override string ToString() => string.Join(",", ToArray().Select(v => v.ToString(CultureInfo.InvariantCulture)));
    }
}
