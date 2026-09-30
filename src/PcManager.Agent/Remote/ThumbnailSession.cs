using System.Buffers.Binary;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Net.WebSockets;
using System.Text.Json;

namespace PcManager.Agent.Remote;

/// <summary>
/// 썸네일 모드 (--remote-session &lt;url&gt; --thumb). 대시보드 Remote 화면에서 여러 PC를 한눈에 보기 위한 것.
/// 몇 초에 한 번 주 모니터를 작은 JPEG로 보내고, 시계(작업 표시줄)를 뺀 화면이 바뀌지 않은 시간을 함께 알린다.
///
/// 보내는 메시지
///   바이너리: [0]=2(썸네일) [1..4]=움직임 없는 시간(초, LE) [5..]=JPEG
///   텍스트(JSON): hello(모니터 크기), error
/// </summary>
internal sealed class ThumbnailSession(ClientWebSocket socket) : IDisposable
{
    private const int Interval = 3000;
    private const int ThumbWidth = 320;
    private const long JpegQuality = 60;
    /// <summary>작업 표시줄(시계·트레이) 높이만큼 아래를 비교에서 뺀다 (썸네일 기준)</summary>
    private const int IgnoreBottomRatio = 20; // 높이의 1/20 ≈ 1080p에서 54px
    /// <summary>바뀐 픽셀이 이 비율(‰) 미만이면 "변화 없음"</summary>
    private const int ChangePerMille = 3;
    private const int PixelThreshold = 24;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly CancellationTokenSource _cts = new();

    public async Task RunAsync()
    {
        var ct = _cts.Token;
        var capture = new Thread(CaptureLoop) { IsBackground = true, Name = "thumb-capture" };
        capture.Start();
        try
        {
            // 서버가 닫을 때까지 수신 대기 (받는 메시지는 없다)
            var buffer = new byte[4096];
            while (!ct.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                var result = await socket.ReceiveAsync(buffer, ct);
                if (result.MessageType == WebSocketMessageType.Close)
                    break;
            }
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException)
        {
            // 연결 종료
        }
        finally
        {
            await _cts.CancelAsync();
            capture.Join(TimeSpan.FromSeconds(3));
        }
    }

    private void CaptureLoop()
    {
        var ct = _cts.Token;
        IScreenCapturer? capturer = null;
        byte[] bgra = [];
        byte[]? previousGray = null;
        var lastChange = Stopwatch.StartNew();
        var preferGdi = false;
        var noFrameSince = Stopwatch.StartNew();
        var helloSent = false;

        try
        {
            // 모니터가 없는 PC는 화면이 그려지지 않아 검게 나온다 → 가상 모니터를 켠다 (원격조작과 같은 처리, 켠 뒤 유지)
            try
            {
                VirtualDisplay.EnsureForHeadless(m => Trace.WriteLine(m));
            }
            catch (Exception ex)
            {
                Send(JsonSerializer.SerializeToUtf8Bytes(new { type = "error", message = $"가상 모니터 준비 실패: {ex.Message}" }, Json), WebSocketMessageType.Text);
            }

            while (!ct.IsCancellationRequested)
            {
                var desktopChanged = DesktopSwitcher.SyncThreadToInputDesktop();
                if (desktopChanged || capturer is null)
                {
                    capturer?.Dispose();
                    capturer = null;
                    try
                    {
                        var displays = DisplayModes.Enumerate();
                        var bounds = displays.Count == 0 ? new Rectangle(0, 0, 1024, 768) : displays.FirstOrDefault(d => d.Primary, displays[0]).Bounds;
                        capturer = preferGdi ? new GdiCapturer(bounds) : CreateCapturer(bounds);
                        noFrameSince.Restart();
                        if (bgra.Length != bounds.Width * bounds.Height * 4)
                            bgra = new byte[bounds.Width * bounds.Height * 4];
                        if (!helloSent)
                        {
                            helloSent = true;
                            Send(JsonSerializer.SerializeToUtf8Bytes(new { type = "hello", width = bounds.Width, height = bounds.Height, desktop = DesktopSwitcher.CurrentName }, Json), WebSocketMessageType.Text);
                        }
                    }
                    catch (Exception ex)
                    {
                        Send(JsonSerializer.SerializeToUtf8Bytes(new { type = "error", message = ex.Message }, Json), WebSocketMessageType.Text);
                        Thread.Sleep(Interval);
                        continue;
                    }
                }

                CaptureStatus status;
                try
                {
                    status = capturer.Capture(bgra, 500);
                }
                catch (Exception)
                {
                    capturer.Dispose();
                    capturer = null;
                    Thread.Sleep(500);
                    continue;
                }
                if (status == CaptureStatus.Lost)
                {
                    capturer.Dispose();
                    capturer = null;
                    continue;
                }
                if (status == CaptureStatus.NoChange && previousGray is null)
                {
                    // 아직 첫 프레임이 없다: DXGI가 프레임을 안 주면 GDI로
                    if (capturer is DxgiCapturer && noFrameSince.ElapsedMilliseconds > 3000)
                    {
                        preferGdi = true;
                        capturer.Dispose();
                        capturer = null;
                    }
                    continue;
                }

                // 축소 → 회색조 비교(작업 표시줄 제외) → JPEG
                var b = capturer.Bounds;
                var (thumb, gray) = MakeThumbnail(bgra, b.Width, b.Height);
                if (previousGray is null || Changed(previousGray, gray, thumb.Width, thumb.Height))
                    lastChange.Restart();
                previousGray = gray;

                var jpeg = EncodeJpeg(thumb);
                thumb.Dispose();
                var packet = new byte[5 + jpeg.Length];
                packet[0] = 2;
                BinaryPrimitives.WriteInt32LittleEndian(packet.AsSpan(1), (int)lastChange.Elapsed.TotalSeconds);
                jpeg.CopyTo(packet, 5);
                Send(packet, WebSocketMessageType.Binary);

                Thread.Sleep(Interval);
            }
        }
        catch (OperationCanceledException)
        {
            // 종료
        }
        finally
        {
            capturer?.Dispose();
        }
    }

    private static IScreenCapturer CreateCapturer(Rectangle bounds)
    {
        try
        {
            return new DxgiCapturer(bounds);
        }
        catch (Exception)
        {
            return new GdiCapturer(bounds);
        }
    }

    private static unsafe (Bitmap Thumb, byte[] Gray) MakeThumbnail(byte[] bgra, int width, int height)
    {
        var tw = ThumbWidth;
        var th = Math.Max(2, (int)Math.Round((double)height * tw / width));
        var thumb = new Bitmap(tw, th, PixelFormat.Format24bppRgb);
        fixed (byte* src = bgra)
        {
            using var source = new Bitmap(width, height, width * 4, PixelFormat.Format32bppRgb, (IntPtr)src);
            using var g = Graphics.FromImage(thumb);
            g.InterpolationMode = InterpolationMode.HighQualityBilinear;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(source, new Rectangle(0, 0, tw, th));
        }

        var gray = new byte[tw * th];
        var data = thumb.LockBits(new Rectangle(0, 0, tw, th), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try
        {
            for (var y = 0; y < th; y++)
            {
                var row = (byte*)data.Scan0 + y * data.Stride;
                for (var x = 0; x < tw; x++)
                {
                    var p = row + x * 3;
                    gray[y * tw + x] = (byte)((p[0] * 29 + p[1] * 150 + p[2] * 77) >> 8);
                }
            }
        }
        finally
        {
            thumb.UnlockBits(data);
        }
        return (thumb, gray);
    }

    /// <summary>작업 표시줄 영역(아래쪽)을 제외하고 눈에 띄게 바뀐 픽셀 비율로 판단한다</summary>
    private static bool Changed(byte[] previous, byte[] current, int width, int height)
    {
        var compareHeight = height - Math.Max(1, height / IgnoreBottomRatio);
        var total = width * compareHeight;
        var changed = 0;
        for (var i = 0; i < total; i++)
        {
            if (Math.Abs(previous[i] - current[i]) > PixelThreshold)
                changed++;
        }
        return changed * 1000L > (long)total * ChangePerMille;
    }

    private static byte[] EncodeJpeg(Bitmap bitmap)
    {
        var codec = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
        using var parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(Encoder.Quality, JpegQuality);
        using var stream = new MemoryStream();
        bitmap.Save(stream, codec, parameters);
        return stream.ToArray();
    }

    private void Send(byte[] data, WebSocketMessageType type)
    {
        try
        {
            if (socket.State == WebSocketState.Open)
                socket.SendAsync(data, type, true, _cts.Token).GetAwaiter().GetResult();
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException)
        {
            _cts.Cancel();
        }
    }

    public void Dispose() => _cts.Dispose();
}
