using System.Diagnostics;

namespace PcManager.Agent.Linux.Remote;

/// <summary>한 장면(액세스 유닛): Annex B H.264 바이트, 키 프레임 여부</summary>
internal readonly record struct EncodedFrame(byte[] Data, bool IsKeyFrame);

/// <summary>
/// ffmpeg x11grab → libx264(Baseline, 저지연) → Annex B를 표준 출력으로 받아 프레임 단위로 나눈다.
/// 프레임 경계는 x264가 넣는 AUD(NAL 9)로 찾고, 키 프레임마다 SPS/PPS를 반복한다
/// (브라우저가 SPS로 코덱 문자열을 만들고, 중간에 들어와도 바로 디코딩하도록)
/// </summary>
internal sealed class H264Capture : IDisposable
{
    private readonly Process _process;
    private readonly Stream _stdout;
    private readonly byte[] _buffer = new byte[1 << 20];
    private int _length;
    private readonly List<byte[]> _pendingNals = [];
    private readonly Queue<EncodedFrame> _ready = new();

    public H264Capture(string display, Monitor monitor, int width, int height, int fps, int bitrate)
    {
        var info = new ProcessStartInfo("ffmpeg")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
        };
        foreach (var arg in new[]
        {
            "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "x11grab", "-draw_mouse", "0", "-framerate", fps.ToString(),
            "-video_size", $"{monitor.Width}x{monitor.Height}",
            "-i", $"{display}+{monitor.X},{monitor.Y}",
            "-vf", $"scale={width}:{height}:flags=fast_bilinear,format=yuv420p",
            "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline",
            "-b:v", bitrate.ToString(), "-maxrate", bitrate.ToString(), "-bufsize", (bitrate / 2).ToString(),
            "-g", (fps * 2).ToString(), "-x264-params", "aud=1:repeat-headers=1",
            "-flush_packets", "1", "-f", "h264", "-",
        })
            info.ArgumentList.Add(arg);

        _process = Process.Start(info) ?? throw new InvalidOperationException("ffmpeg를 시작하지 못했습니다.");
        _stdout = _process.StandardOutput.BaseStream;
        // 오류 출력은 버퍼가 차서 멈추지 않도록 읽어 버린다 (마지막 줄만 보관)
        _process.ErrorDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) LastError = e.Data; };
        _process.BeginErrorReadLine();
    }

    public string? LastError { get; private set; }

    /// <summary>다음 프레임. 스트림이 끝나면(ffmpeg 종료) null</summary>
    public async Task<EncodedFrame?> ReadFrameAsync(CancellationToken ct)
    {
        while (_ready.Count == 0)
        {
            if (_length == _buffer.Length)
                throw new InvalidOperationException("프레임이 너무 큽니다.");
            var read = await _stdout.ReadAsync(_buffer.AsMemory(_length), ct);
            if (read == 0)
                return null;
            _length += read;
            SplitNals();
        }
        return _ready.Dequeue();
    }

    /// <summary>버퍼에서 완성된 NAL을 꺼낸다 (다음 시작 코드가 보여야 앞 NAL이 끝난 것)</summary>
    private void SplitNals()
    {
        var start = FindStartCode(0);
        if (start < 0)
            return;
        while (true)
        {
            var next = FindStartCode(start + 3);
            if (next < 0)
                break;
            OnNal(_buffer.AsSpan(start, next - start).ToArray());
            start = next;
        }
        // 남은 조각(아직 끝나지 않은 NAL)을 앞으로 당긴다
        Buffer.BlockCopy(_buffer, start, _buffer, 0, _length - start);
        _length -= start;
    }

    private int FindStartCode(int from)
    {
        for (var i = from; i + 3 <= _length; i++)
        {
            if (_buffer[i] == 0 && _buffer[i + 1] == 0)
            {
                if (_buffer[i + 2] == 1)
                    return i > 0 && _buffer[i - 1] == 0 ? i - 1 : i;
            }
        }
        return -1;
    }

    private void OnNal(byte[] nal)
    {
        var header = nal[2] == 1 ? 3 : 4;
        if (nal.Length <= header)
            return;
        var type = nal[header] & 0x1F;
        if (type == 9)
        {
            // AUD = 새 프레임 시작 → 지금까지 모은 NAL이 한 프레임
            Flush();
            return;
        }
        _pendingNals.Add(nal);
    }

    private void Flush()
    {
        if (_pendingNals.Count == 0)
            return;
        var key = _pendingNals.Any(n => (n[n[2] == 1 ? 3 : 4] & 0x1F) == 5);
        var data = new byte[_pendingNals.Sum(n => n.Length)];
        var offset = 0;
        foreach (var n in _pendingNals)
        {
            Buffer.BlockCopy(n, 0, data, offset, n.Length);
            offset += n.Length;
        }
        _pendingNals.Clear();
        _ready.Enqueue(new EncodedFrame(data, key));
    }

    public void Dispose()
    {
        try
        {
            if (!_process.HasExited)
                _process.Kill();
            _process.WaitForExit(2000);
        }
        catch (InvalidOperationException)
        {
        }
        _process.Dispose();
    }
}
