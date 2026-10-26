using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using Microsoft.Extensions.Logging;

namespace PcManager.Agent;

/// <summary>
/// ffmpeg에서 GPU 쓰기 (영상 분석·이미지 찾기·재생용 사본·자르기).
/// GPU 고르기: Windows는 DXGI 그래픽 장치 중 가상 디스플레이·기본 렌더러를 빼고(NVIDIA·AMD·Intel만) 외장 → 내장(전용 메모리 큰 순)으로
/// <c>-hwaccel d3d11va -hwaccel_device 번호</c>를 차례로 써 본다 (FindAdapters — Windows 에이전트가 넣음). Linux는 -hwaccel auto.
/// 필터는 CPU에서 하므로 풀린 프레임은 자동으로 메모리로 옮겨진다.
/// 영상 분석은 NVIDIA면 먼저 NVDEC 디코더(cuvid)가 화면 영역을 잘라 줄여서 내보내게 한다 (Cuvid): 1080p 프레임을 통째로 CPU로 옮기고
/// 자르고 줄이던 일이 없어져 CPU 시간이 절반 아래로 (분석이 CPU에 막혀 있으면 그만큼 빨라짐).
/// 디코딩이 안 되면 그 영상만 다음 GPU → CPU로 다시 하고, 같은 영상은 다음부터 바로 CPU로. GPU 하나가 여러 번 실패하면 그 GPU는 그만 쓰고,
/// 여러 영상이 GPU로 안 되면 GPU 디코딩을 끈다 (이유는 PC 정보에).
/// 인코딩: 이 PC에서 실제로 되는 하드웨어 H.264 인코더 (외장 → 내장 GPU의 제조사 순으로 nvenc·qsv·amf, 짧은 시험 인코딩으로 확인, 없으면 libx264).
/// 하드웨어 인코딩이 실패했는데 CPU로는 되면 이 에이전트가 끝날 때까지 CPU로만 한다
/// </summary>
internal static class FfmpegGpu
{
    /// <summary>GPU 하나 (Index: DXGI 장치 번호 = ffmpeg d3d11va 장치 번호)</summary>
    public sealed record Adapter(int Index, string Name, uint VendorId, long DedicatedMemory);

    /// <summary>GPU 디코딩 방식: -hwaccel(d3d11va·auto, 풀린 프레임을 통째로 받음) · NVIDIA cuvid 디코더(GPU에서 자르고 줄여 받음, 분석만)</summary>
    public enum DecodeKind
    {
        Hwaccel,
        Cuvid,
    }

    /// <summary>
    /// GPU 디코딩 방법 하나 (Adapter: DXGI 장치 번호, 자동이면 -1). Args: -i 앞에 넣을 옵션 (Cuvid면 비어 있고 부르는 쪽이 -c:v·-crop·-resize를 만든다).
    /// CudaIndex: Cuvid의 -gpu (NVIDIA 장치 차례)
    /// </summary>
    public sealed record DecodeOption(int Adapter, string Name, string[] Args, DecodeKind Kind = DecodeKind.Hwaccel, int CudaIndex = 0)
    {
        /// <summary>실패를 세는 열쇠 (같은 GPU라도 방식마다 따로)</summary>
        public string Key => $"{Kind}:{Adapter}";
    }

    private static readonly string[] Encoders = ["h264_nvenc", "h264_qsv", "h264_amf"];
    // GPU 하나가 이만큼 실패하면 그 GPU는 그만 쓴다 · 이만큼 많은 영상이 GPU로 안 되면 GPU 디코딩을 끈다
    private const int MaxAdapterFailures = 3;
    private const int MaxVideoFailures = 3;
    private static readonly Lock Gate = new();
    private static readonly ConcurrentDictionary<string, int> AdapterFailures = new();
    private static readonly ConcurrentDictionary<string, string> FailedVideos = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Lazy<IReadOnlyList<Adapter>> AdapterList = new(() => FindAdapters?.Invoke() ?? []);
    private static volatile string? _lastFailure;
    private static volatile bool _decodeOff;
    private static volatile bool _encodeOff;
    private static Task<string?>? _encoder;

    /// <summary>쓸 GPU를 찾는 함수 (Windows 에이전트가 DXGI로 넣는다). 없으면(Linux) ffmpeg가 고른다 (-hwaccel auto)</summary>
    public static Func<IReadOnlyList<Adapter>>? FindAdapters { get; set; }

    /// <summary>쓸 GPU (외장 → 내장, 가상 디스플레이·기본 렌더러 뺌)</summary>
    public static IReadOnlyList<Adapter> Adapters => AdapterList.Value;

    /// <summary>이 영상을 풀 때 차례로 써 볼 GPU 디코딩 방법 (없으면 CPU로). cuvid: NVIDIA는 cuvid(GPU에서 자르고 줄이기)를 먼저</summary>
    public static IReadOnlyList<DecodeOption> DecodeOptions(string path, bool cuvid = false)
    {
        if (_decodeOff || FailedVideos.ContainsKey(path))
            return [];
        var list = new List<DecodeOption>();
        if (FindAdapters is null)
            list.Add(new DecodeOption(-1, "자동", ["-hwaccel", "auto"]));
        else
        {
            var nvidia = 0;
            foreach (var a in Adapters)
            {
                if (cuvid && a.VendorId == 0x10DE)
                    list.Add(new DecodeOption(a.Index, $"{a.Name} (GPU에서 영역 자르기·줄이기)", [], DecodeKind.Cuvid, nvidia));
                if (a.VendorId == 0x10DE)
                    nvidia++;
                list.Add(new DecodeOption(a.Index, a.Name, ["-hwaccel", "d3d11va", "-hwaccel_device", a.Index.ToString(CultureInfo.InvariantCulture)]));
            }
        }
        return list.Where(o => AdapterFailures.GetValueOrDefault(o.Key) < MaxAdapterFailures).ToList();
    }

    /// <summary>NVIDIA cuvid 디코더 이름 (영상 코덱 → h264_cuvid 등, 지원하지 않는 코덱이면 null)</summary>
    public static string? CuvidDecoder(string? codec) => codec switch
    {
        "h264" => "h264_cuvid",
        "hevc" => "hevc_cuvid",
        "av1" => "av1_cuvid",
        "vp9" => "vp9_cuvid",
        "vp8" => "vp8_cuvid",
        "mpeg1video" => "mpeg1_cuvid",
        "mpeg2video" => "mpeg2_cuvid",
        "mpeg4" => "mpeg4_cuvid",
        "mjpeg" => "mjpeg_cuvid",
        "vc1" => "vc1_cuvid",
        _ => null,
    };

    /// <summary>
    /// GPU 디코딩 방법들을 차례로 해 보고 모두 안 되면 CPU로 (attempt(디코딩 방법, CPU면 null) → 결과. 실패는 InvalidOperationException
    /// 또는 failure(결과)가 이유를 돌려줌). 안 된 GPU는 다음 GPU나 CPU로 됐을 때만 실패로 센다 (영상이 원래 못 읽는 것이면 세지 않는다).
    /// cuvid: NVIDIA cuvid(GPU에서 자르고 줄이기)도 써 본다 (부르는 쪽이 그 방식을 만들 수 있을 때)
    /// </summary>
    public static async Task<T> DecodeAsync<T>(ILogger logger, string path, Func<DecodeOption?, Task<T>> attempt, Func<T, string?> failure,
        bool cuvid = false)
    {
        var tried = new List<(DecodeOption Option, string Error)>();
        foreach (var option in DecodeOptions(path, cuvid))
        {
            string error;
            try
            {
                var result = await attempt(option);
                if (failure(result) is not { } reason)
                {
                    Record(logger, path, tried, gpuWorked: true);
                    return result;
                }
                error = reason;
            }
            catch (InvalidOperationException ex)
            {
                error = ex.Message;
            }
            tried.Add((option, error));
        }
        var cpu = await attempt(null);
        if (failure(cpu) is null)
            Record(logger, path, tried, gpuWorked: false);
        return cpu;
    }

    private static void Record(ILogger logger, string path, List<(DecodeOption Option, string Error)> tried, bool gpuWorked)
    {
        foreach (var (option, error) in tried)
        {
            var count = AdapterFailures.AddOrUpdate(option.Key, 1, (_, c) => c + 1);
            logger.LogWarning("GPU 디코딩 실패 ({Gpu}, {File}): {Error}", option.Name, Path.GetFileName(path), error);
            if (count == MaxAdapterFailures)
                logger.LogWarning("GPU {Gpu}는 디코딩이 {Count}번 실패해 이제 쓰지 않습니다", option.Name, count);
        }
        if (gpuWorked || tried.Count == 0)
            return;
        // 어느 GPU로도 안 되고 CPU로는 된 영상: 다음부터 바로 CPU로
        FailedVideos[path] = tried[^1].Error;
        _lastFailure = $"{Path.GetFileName(path)} — {Short(tried[^1].Error)}";
        if (FailedVideos.Count >= MaxVideoFailures && !_decodeOff)
        {
            _decodeOff = true;
            logger.LogWarning("영상 {Count}개가 GPU로 디코딩되지 않아 이제 CPU로만 디코딩합니다", FailedVideos.Count);
        }
    }

    private static string Short(string error) => error.Length > 160 ? error[..160] + "…" : error;

    /// <summary>다시 인코딩할 때 쓸 디코딩 옵션 (첫 GPU, 없으면 CPU)</summary>
    public static string[] TranscodeDecodeArgs(string path) => DecodeOptions(path).FirstOrDefault()?.Args ?? [];

    /// <summary>분석에서 GPU에서 영역 자르기·줄이기(cuvid)를 쓰는 GPU 이름 (실패해 그만 쓰면 빠짐)</summary>
    private static bool CuvidUsable(Adapter a) => a.VendorId == 0x10DE && AdapterFailures.GetValueOrDefault($"{DecodeKind.Cuvid}:{a.Index}") < MaxAdapterFailures;

    /// <summary>쓸 수 있는 하드웨어 H.264 인코더 (없거나 실패한 적이 있으면 null = libx264)</summary>
    public static Task<string?> EncoderAsync(string ffmpeg)
    {
        if (_encodeOff)
            return Task.FromResult<string?>(null);
        lock (Gate)
            return _encoder ??= DetectAsync(ffmpeg);
    }

    /// <summary>하드웨어 인코딩은 실패하고 CPU로는 됐다 → 앞으로 libx264로만</summary>
    public static void EncodeFailed(ILogger logger, string? encoder, string error)
    {
        if (_encodeOff)
            return;
        _encodeOff = true;
        logger.LogWarning("GPU 인코딩({Encoder}) 실패, 이제 CPU(libx264)로만 인코딩합니다: {Error}", encoder, error);
    }

    /// <summary>제조사의 GPU 순위 (외장 → 내장 차례, 없으면 맨 뒤): 하드웨어 인코더도 이 차례로 고른다</summary>
    public static int VendorRank(uint vendorId)
    {
        var list = Adapters;
        for (var i = 0; i < list.Count; i++)
            if (SameVendor(list[i].VendorId, vendorId))
                return i;
        return int.MaxValue;
    }

    // AMD는 그래픽 1002, 일부 APU가 1022
    private static bool SameVendor(uint a, uint b) => a == b || (a is 0x1002 or 0x1022 && b is 0x1002 or 0x1022);

    /// <summary>PC 정보에 보여 줄 지금 상태 (영상 분석·찾기 디코딩 · 사본 변환·자르기 인코딩)</summary>
    public static IEnumerable<string> Status()
    {
        const string decode = "영상 분석·이미지 찾기 디코딩";
        var failure = _lastFailure;
        if (_decodeOff)
            yield return $"{decode}: CPU (영상 {FailedVideos.Count}개가 GPU로 디코딩되지 않아 바꿈 — {failure})";
        else if (FindAdapters is null)
            yield return $"{decode}: GPU (자동, GPU로 안 되는 영상은 CPU){(failure is null ? "" : $" · GPU로 안 된 영상: {failure}")}";
        else
        {
            var usable = Adapters.Where(a => AdapterFailures.GetValueOrDefault($"{DecodeKind.Hwaccel}:{a.Index}") < MaxAdapterFailures || CuvidUsable(a))
                .Select(a => CuvidUsable(a) ? $"{a.Name}, 분석은 영역 자르기·줄이기까지 GPU" : a.Name).ToList();
            yield return Adapters.Count == 0 ? $"{decode}: CPU (쓸 수 있는 GPU 없음 — 가상·기본 디스플레이는 뺌)"
                : usable.Count == 0 ? $"{decode}: CPU (GPU 디코딩이 계속 실패해 바꿈 — {failure})"
                : $"{decode}: GPU ({string.Join(" → ", usable)}){(failure is null ? "" : $" · GPU로 안 된 영상: {failure}")}";
        }
        yield return _encodeOff ? "사본 변환·자르기 인코딩: CPU (GPU 인코딩이 실패해 바꿈)"
            : _encoder is { IsCompletedSuccessfully: true } done
                ? done.Result is { } name ? $"사본 변환·자르기 인코딩: GPU ({name})" : "사본 변환·자르기 인코딩: CPU (하드웨어 인코더 없음)"
                : "사본 변환·자르기 인코딩: 확인 전 (처음 변환할 때 GPU 인코더를 찾음)";
    }

    /// <summary>H.264 인코딩 옵션 (encoder가 null이면 libx264). 화질은 libx264 -crf 23쯤</summary>
    public static string[] EncodeArgs(string? encoder) => encoder switch
    {
        "h264_nvenc" => ["-c:v", "h264_nvenc", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-pix_fmt", "yuv420p"],
        "h264_qsv" => ["-c:v", "h264_qsv", "-global_quality", "23", "-pix_fmt", "nv12"],
        "h264_amf" => ["-c:v", "h264_amf", "-rc", "cqp", "-qp_i", "22", "-qp_p", "24", "-pix_fmt", "nv12"],
        _ => ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"],
    };

    /// <summary>시험할 인코더 차례: 외장 → 내장 GPU의 제조사 순, 그다음 나머지</summary>
    private static IEnumerable<string> EncoderOrder() =>
        Adapters.Select(a => a.VendorId switch
            {
                0x10DE => "h264_nvenc",
                0x8086 => "h264_qsv",
                0x1002 or 0x1022 => "h264_amf",
                _ => null,
            })
            .OfType<string>()
            .Concat(Encoders)
            .Distinct();

    private static async Task<string?> DetectAsync(string ffmpeg)
    {
        foreach (var name in EncoderOrder())
            if (await TryEncodeAsync(ffmpeg, name))
                return name;
        return null;
    }

    /// <summary>합성 영상 10프레임을 그 인코더로 인코딩해 본다 (드라이버·장치가 없으면 실패)</summary>
    private static async Task<bool> TryEncodeAsync(string ffmpeg, string name)
    {
        var info = new ProcessStartInfo(ffmpeg)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };
        string[] args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=1",
            .. EncodeArgs(name), "-frames:v", "10", "-f", "null", "-"];
        foreach (var arg in args)
            info.ArgumentList.Add(arg);
        try
        {
            using var process = Process.Start(info);
            if (process is null)
                return false;
            _ = process.StandardError.ReadToEndAsync();
            _ = process.StandardOutput.ReadToEndAsync();
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            try
            {
                await process.WaitForExitAsync(timeout.Token);
            }
            catch (OperationCanceledException)
            {
                process.Kill(entireProcessTree: true);
                return false;
            }
            return process.ExitCode == 0;
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
        {
            return false;
        }
    }
}
