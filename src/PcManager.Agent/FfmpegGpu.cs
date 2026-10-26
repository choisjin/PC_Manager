using System.ComponentModel;
using System.Diagnostics;
using Microsoft.Extensions.Logging;

namespace PcManager.Agent;

/// <summary>
/// ffmpeg에서 GPU 쓰기 (영상 분석·이미지 찾기·재생용 사본·자르기).
/// 디코딩: -hwaccel auto (Windows d3d11va·dxva2·qsv·cuda, Linux vaapi 등 — 그 영상에 쓸 수 없으면 ffmpeg가 CPU로 푼다.
/// 필터는 CPU에서 하므로 풀린 프레임은 자동으로 메모리로 옮겨진다).
/// 인코딩: 이 PC에서 실제로 되는 하드웨어 H.264 인코더 (NVIDIA nvenc → Intel qsv → AMD amf, 짧은 시험 인코딩으로 확인, 없으면 libx264).
/// GPU로 하다 실패했는데 CPU로는 되면 이 에이전트가 끝날 때까지 CPU로만 한다
/// </summary>
internal static class FfmpegGpu
{
    private static readonly string[] Encoders = ["h264_nvenc", "h264_qsv", "h264_amf"];
    private static readonly Lock Gate = new();
    private static volatile bool _decodeOff;
    private static volatile bool _encodeOff;
    private static Task<string?>? _encoder;

    /// <summary>GPU 디코딩을 해 볼지</summary>
    public static bool Decode => !_decodeOff;

    /// <summary>-i 앞에 넣는 디코딩 옵션</summary>
    public static string[] DecodeArgs(bool on) => on ? ["-hwaccel", "auto"] : [];

    /// <summary>GPU 디코딩은 실패하고 CPU로는 됐다 → 앞으로 CPU로만</summary>
    public static void DecodeFailed(ILogger logger, string error)
    {
        if (_decodeOff)
            return;
        _decodeOff = true;
        logger.LogWarning("GPU 디코딩 실패, 이제 CPU로만 디코딩합니다: {Error}", error);
    }

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

    /// <summary>H.264 인코딩 옵션 (encoder가 null이면 libx264). 화질은 libx264 -crf 23쯤</summary>
    public static string[] EncodeArgs(string? encoder) => encoder switch
    {
        "h264_nvenc" => ["-c:v", "h264_nvenc", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-pix_fmt", "yuv420p"],
        "h264_qsv" => ["-c:v", "h264_qsv", "-global_quality", "23", "-pix_fmt", "nv12"],
        "h264_amf" => ["-c:v", "h264_amf", "-rc", "cqp", "-qp_i", "22", "-qp_p", "24", "-pix_fmt", "nv12"],
        _ => ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"],
    };

    private static async Task<string?> DetectAsync(string ffmpeg)
    {
        foreach (var name in Encoders)
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
