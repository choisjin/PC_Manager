using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Forms;
using PcManager.Shared;

namespace PcManager.Agent.Remote;

/// <summary>
/// 원격조작 세션 프로세스 (--remote-session). 서비스가 사용자 세션에 SYSTEM 권한으로 띄운다.
/// 서버와 WebSocket 하나로 연결해 화면(H.264)을 보내고, 브라우저의 입력을 받아 SendInput으로 넣는다.
/// 연결이 끊기면 종료한다 (보는 사람마다 프로세스 하나).
///
/// 보내는 메시지
///   바이너리: [0]=1(영상) [1]=플래그(1=키 프레임) [2..9]=타임스탬프(µs, LE) [10..]=H.264 Annex B
///   텍스트(JSON): hello(모니터 목록), format(해상도), cursor(커서 위치), status(데스크톱 전환 등), error
/// 받는 메시지 (JSON, t 필드로 구분)
///   m(이동) md/mu(버튼) w(휠) kd/ku(키) combo(조합 키) text(문자열) monitor(모니터 전환) keyframe quality
/// </summary>
internal static class RemoteSessionApp
{
    public const string TokenEnvironmentVariable = "PCM_AGENT_TOKEN";

    private const int Fps = 30;
    private const int MaxEncodeWidth = 2560;
    private static readonly TimeSpan NoFrameFallback = TimeSpan.FromSeconds(3);

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static int Run(string url)
    {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        try
        {
            return RunAsync(new Uri(url)).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"원격 세션 오류: {ex}");
            return 1;
        }
    }

    private static async Task<int> RunAsync(Uri url)
    {
        using var socket = new ClientWebSocket();
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
        var token = Environment.GetEnvironmentVariable(TokenEnvironmentVariable) ?? ReadInstalledToken();
        if (!string.IsNullOrEmpty(token))
            socket.Options.SetRequestHeader(AgentHeaders.Token, token);

        using (var connectTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(15)))
            await socket.ConnectAsync(url, connectTimeout.Token);

        using var session = new Session(socket);
        await session.RunAsync();
        return 0;
    }

    /// <summary>서비스는 agent.json의 토큰을 쓴다. 이 프로세스도 SYSTEM이라 같은 파일을 읽을 수 있다</summary>
    private static string? ReadInstalledToken()
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(AgentOptions.InstalledConfigPath));
            return doc.RootElement.TryGetProperty("Agent", out var agent) && agent.TryGetProperty("Token", out var t)
                ? t.GetString()
                : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    private sealed class Session(ClientWebSocket socket) : IDisposable
    {
        private readonly CancellationTokenSource _cts = new();
        private readonly SemaphoreSlim _sendLock = new(1, 1);
        private readonly BlockingCollection<Action> _inputQueue = new(boundedCapacity: 1000);

        // 캡처 스레드가 정하고 입력 스레드가 읽는 값
        private volatile int _monitorIndex = -1; // -1: 주 모니터
        private volatile bool _keyFrameRequested = true;
        private volatile int _bitrate = 6_000_000;
        // 대시보드(보는 쪽) 화면 크기. 스트림을 이 크기에 맞춰 줄인다. 0이면 아직 모름 → 원본 기준
        private volatile int _viewWidth;
        private volatile int _viewHeight;
        private Rectangle _monitorBounds;
        private readonly Lock _boundsLock = new();

        private Rectangle MonitorBounds
        {
            get { lock (_boundsLock) return _monitorBounds; }
            set { lock (_boundsLock) _monitorBounds = value; }
        }

        public async Task RunAsync()
        {
            var ct = _cts.Token;
            await SendJsonAsync(new { type = "hello", monitors = DescribeMonitors(), desktop = DesktopSwitcher.CurrentName }, ct);

            var capture = new Thread(CaptureLoop) { IsBackground = true, Name = "remote-capture" };
            var input = new Thread(InputLoop) { IsBackground = true, Name = "remote-input" };
            capture.Start();
            input.Start();

            try
            {
                await ReceiveLoopAsync(ct);
            }
            finally
            {
                await _cts.CancelAsync();
                _inputQueue.CompleteAdding();
                capture.Join(TimeSpan.FromSeconds(3));
                input.Join(TimeSpan.FromSeconds(3));
            }
        }

        private async Task ReceiveLoopAsync(CancellationToken ct)
        {
            var buffer = new byte[64 * 1024];
            using var message = new MemoryStream();
            while (!ct.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                WebSocketReceiveResult result;
                try
                {
                    result = await socket.ReceiveAsync(buffer, ct);
                }
                catch (Exception ex) when (ex is WebSocketException or OperationCanceledException)
                {
                    return;
                }

                if (result.MessageType == WebSocketMessageType.Close)
                    return;
                message.Write(buffer, 0, result.Count);
                if (!result.EndOfMessage)
                    continue;

                if (result.MessageType == WebSocketMessageType.Text)
                {
                    try
                    {
                        HandleMessage(message.GetBuffer().AsSpan(0, (int)message.Length));
                    }
                    catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
                    {
                        // 잘못된 메시지는 무시
                    }
                }
                message.SetLength(0);
            }
        }

        private void HandleMessage(ReadOnlySpan<byte> utf8)
        {
            using var doc = JsonDocument.Parse(utf8.ToArray());
            var root = doc.RootElement;
            var type = root.GetProperty("t").GetString();
            switch (type)
            {
                case "m":
                {
                    var (x, y) = (root.GetProperty("x").GetDouble(), root.GetProperty("y").GetDouble());
                    EnqueueInput(() => InputInjector.MoveMouse(MonitorBounds, x, y));
                    break;
                }
                case "md" or "mu":
                {
                    var (x, y) = (root.GetProperty("x").GetDouble(), root.GetProperty("y").GetDouble());
                    var button = root.GetProperty("b").GetInt32();
                    var down = type == "md";
                    EnqueueInput(() => InputInjector.MouseButton(MonitorBounds, x, y, button, down));
                    break;
                }
                case "w":
                {
                    var dx = root.TryGetProperty("dx", out var px) ? px.GetInt32() : 0;
                    var dy = root.TryGetProperty("dy", out var py) ? py.GetInt32() : 0;
                    EnqueueInput(() => InputInjector.Wheel(dx, dy));
                    break;
                }
                case "kd" or "ku":
                {
                    var code = root.GetProperty("code").GetString() ?? "";
                    var key = root.TryGetProperty("key", out var k) ? k.GetString() : null;
                    var down = type == "kd";
                    var mods = new InputInjector.Modifiers(
                        Flag(root, "shift"), Flag(root, "ctrl"), Flag(root, "alt"), Flag(root, "meta"));
                    EnqueueInput(() => InputInjector.Key(code, key, down, mods));
                    break;
                }
                case "combo":
                {
                    var codes = root.GetProperty("codes").EnumerateArray().Select(c => c.GetString() ?? "").ToList();
                    EnqueueInput(() => InputInjector.Combo(codes));
                    break;
                }
                case "reset":
                    EnqueueInput(InputInjector.ReleaseModifiers);
                    break;
                case "text":
                {
                    var text = root.GetProperty("text").GetString() ?? "";
                    EnqueueInput(() => InputInjector.Text(text));
                    break;
                }
                case "monitor":
                    _monitorIndex = root.GetProperty("index").GetInt32();
                    break;
                case "view":
                    // 대시보드 화면(픽셀) 크기. 스트림 해상도를 여기에 맞춘다
                    _viewWidth = Math.Clamp(root.GetProperty("width").GetInt32(), 0, 8192);
                    _viewHeight = Math.Clamp(root.GetProperty("height").GetInt32(), 0, 8192);
                    break;
                case "keyframe":
                    _keyFrameRequested = true;
                    break;
                case "quality":
                    _bitrate = Math.Clamp(root.GetProperty("bitrate").GetInt32(), 500_000, 30_000_000);
                    break;
            }
        }

        private static bool Flag(JsonElement root, string name) =>
            root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

        private void EnqueueInput(Action action)
        {
            // 입력이 밀리면 오래된 것부터 버리지 않고 새 것을 버린다 (순서 보장: 눌림/뗌 짝이 깨지지 않게)
            _inputQueue.TryAdd(action);
        }

        /// <summary>SendInput은 입력 데스크톱에 붙은 스레드에서만 동작하므로 전용 스레드에서 처리한다</summary>
        private void InputLoop()
        {
            try
            {
                foreach (var action in _inputQueue.GetConsumingEnumerable(_cts.Token))
                {
                    DesktopSwitcher.SyncThreadToInputDesktop();
                    try
                    {
                        action();
                    }
                    catch (Exception ex)
                    {
                        Trace.WriteLine($"입력 실패: {ex.Message}");
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // 종료
            }
        }

        private void CaptureLoop()
        {
            var ct = _cts.Token;
            IScreenCapturer? capturer = null;
            H264Encoder? encoder = null;
            byte[] bgra = [];
            byte[] nv12 = [];
            var hasFrame = false;
            var currentMonitor = int.MinValue;
            var currentBitrate = _bitrate;
            var clock = Stopwatch.StartNew();
            var frameInterval = TimeSpan.FromSeconds(1.0 / Fps);
            var lastEncode = TimeSpan.Zero;
            var lastCursor = new Point(int.MinValue, int.MinValue);
            var failures = 0;
            // DXGI가 만들어지긴 했는데 프레임을 전혀 주지 않는 경우(끊긴 세션, 일부 VM/RDP 디스플레이)를 위한 GDI 전환
            var preferGdi = false;
            var captureStarted = TimeSpan.Zero;

            try
            {
                while (!ct.IsCancellationRequested)
                {
                    // 데스크톱 전환(UAC, 잠금 화면, 로그인)이나 모니터 변경 시 캡처 장치를 다시 만든다
                    var desktopChanged = DesktopSwitcher.SyncThreadToInputDesktop();
                    if (desktopChanged && currentMonitor != int.MinValue)
                        _ = SendJsonAsync(new { type = "status", desktop = DesktopSwitcher.CurrentName }, ct);

                    // 대시보드 화면 크기가 바뀌면(창 크기 조절 등) 인코더 해상도를 다시 맞춘다
                    var monitorChanged = currentMonitor != _monitorIndex;
                    var viewChanged = capturer is not null && TargetSize(capturer.Bounds) != (encoder?.Width ?? 0, encoder?.Height ?? 0);

                    if (desktopChanged || capturer is null || monitorChanged || viewChanged)
                    {
                        currentMonitor = _monitorIndex;
                        if (desktopChanged || capturer is null || monitorChanged)
                        {
                            capturer?.Dispose();
                            capturer = null;
                            var bounds = ResolveMonitor(currentMonitor);
                            try
                            {
                                capturer = CreateCapturer(bounds, preferGdi);
                                captureStarted = clock.Elapsed;
                            }
                            catch (Exception ex)
                            {
                                if (++failures % 20 == 1)
                                    _ = SendJsonAsync(new { type = "error", message = $"화면 캡처를 시작하지 못했습니다: {ex.Message}" }, ct);
                                Thread.Sleep(500);
                                continue;
                            }
                            MonitorBounds = capturer.Bounds;
                            if (bgra.Length != capturer.Bounds.Width * capturer.Bounds.Height * 4)
                                bgra = new byte[capturer.Bounds.Width * capturer.Bounds.Height * 4];
                        }

                        var b = capturer.Bounds;
                        var (width, height) = TargetSize(b);
                        if (encoder is null || encoder.Width != width || encoder.Height != height)
                        {
                            encoder?.Dispose();
                            encoder = new H264Encoder(width, height, Fps, _bitrate);
                            currentBitrate = _bitrate;
                            nv12 = new byte[width * height * 3 / 2];
                        }
                        hasFrame = false;
                        _keyFrameRequested = true;
                        _ = SendJsonAsync(new
                        {
                            type = "format",
                            width = encoder.Width,
                            height = encoder.Height,
                            monitor = new { x = b.X, y = b.Y, width = b.Width, height = b.Height },
                            capture = capturer is DxgiCapturer ? "dxgi" : "gdi",
                            encoder = encoder.Name,
                        }, ct);
                    }

                    // 프레임 간격 유지
                    var wait = lastEncode + frameInterval - clock.Elapsed;
                    if (wait > TimeSpan.Zero)
                        Thread.Sleep(wait);

                    CaptureStatus status;
                    try
                    {
                        status = capturer.Capture(bgra, hasFrame ? 100 : 500);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        // 로그인·데스크톱 전환 중 캡처 장치가 잠깐 무효가 될 수 있다. 세션을 끊지 말고 다시 만든다
                        Trace.WriteLine($"캡처 예외, 재생성: {ex.Message}");
                        capturer.Dispose();
                        capturer = null;
                        Thread.Sleep(200);
                        continue;
                    }
                    if (status == CaptureStatus.Lost)
                    {
                        capturer.Dispose();
                        capturer = null;
                        continue;
                    }
                    failures = 0;

                    // 첫 프레임이 3초 넘게 안 오면 DXGI를 포기하고 GDI(BitBlt)로 바꾼다. GDI는 항상 현재 화면을 돌려준다
                    if (!hasFrame && status == CaptureStatus.NoChange && capturer is DxgiCapturer && clock.Elapsed - captureStarted > NoFrameFallback)
                    {
                        preferGdi = true;
                        capturer.Dispose();
                        capturer = null;
                        _ = SendJsonAsync(new { type = "status", desktop = DesktopSwitcher.CurrentName, note = "dxgi-no-frames" }, ct);
                        continue;
                    }

                    SendCursorIfMoved(ref lastCursor, ct);

                    if (status == CaptureStatus.NewFrame)
                    {
                        Nv12Converter.Convert(bgra, capturer.Bounds.Width, capturer.Bounds.Height, nv12, encoder!.Width, encoder.Height);
                        hasFrame = true;
                    }
                    else if (!_keyFrameRequested || !hasFrame)
                    {
                        continue;
                    }

                    if (currentBitrate != _bitrate)
                    {
                        currentBitrate = _bitrate;
                        encoder!.SetBitrate(currentBitrate);
                    }

                    var forceKey = _keyFrameRequested;
                    _keyFrameRequested = false;
                    lastEncode = clock.Elapsed;
                    var timestamp = lastEncode.Ticks; // 100ns
                    foreach (var frame in encoder!.Encode(nv12, timestamp, forceKey))
                        SendFrame(frame, ct);
                }
            }
            catch (OperationCanceledException)
            {
                // 종료
            }
            catch (Exception ex)
            {
                try
                {
                    SendJsonAsync(new { type = "error", message = $"원격 세션 오류: {ex.Message}" }, CancellationToken.None).Wait(2000);
                }
                catch
                {
                    // 연결이 이미 끊김
                }
                _cts.Cancel();
                _ = socket.CloseOutputAsync(WebSocketCloseStatus.InternalServerError, "capture failed", CancellationToken.None);
            }
            finally
            {
                capturer?.Dispose();
                encoder?.Dispose();
            }
        }

        /// <summary>대시보드 화면 크기에 맞춘 인코딩 해상도 (가로세로 비 유지, 원본보다 크게 늘리지 않음, 짝수)</summary>
        private (int Width, int Height) TargetSize(Rectangle native)
        {
            var vw = _viewWidth;
            var vh = _viewHeight;
            int tw, th;
            if (vw <= 0 || vh <= 0)
            {
                // 아직 대시보드 크기를 모른다: 너무 크면 절반으로 줄인다
                var half = native.Width > MaxEncodeWidth;
                tw = half ? native.Width / 2 : native.Width;
                th = half ? native.Height / 2 : native.Height;
            }
            else
            {
                var s = Math.Min(1.0, Math.Min((double)vw / native.Width, (double)vh / native.Height));
                tw = (int)Math.Round(native.Width * s);
                th = (int)Math.Round(native.Height * s);
            }
            return (Math.Max(2, tw & ~1), Math.Max(2, th & ~1));
        }

        private static IScreenCapturer CreateCapturer(Rectangle bounds, bool preferGdi)
        {
            if (preferGdi)
                return new GdiCapturer(bounds);
            try
            {
                return new DxgiCapturer(bounds);
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"DXGI 캡처 실패, GDI로 전환: {ex.Message}");
                return new GdiCapturer(bounds);
            }
        }

        private static Rectangle ResolveMonitor(int index)
        {
            var screens = Screen.AllScreens;
            if (index >= 0 && index < screens.Length)
                return screens[index].Bounds;
            return (Screen.PrimaryScreen ?? screens[0]).Bounds;
        }

        private static object[] DescribeMonitors() => [.. Screen.AllScreens.Select((s, i) => new
        {
            index = i,
            name = s.DeviceName.TrimStart('\\', '.'),
            primary = s.Primary,
            x = s.Bounds.X,
            y = s.Bounds.Y,
            width = s.Bounds.Width,
            height = s.Bounds.Height,
        })];

        private void SendCursorIfMoved(ref Point last, CancellationToken ct)
        {
            var p = InputInjector.CursorPosition();
            if (p == last)
                return;
            last = p;
            var b = MonitorBounds;
            var inside = b.Contains(p);
            _ = SendJsonAsync(new
            {
                type = "cursor",
                x = b.Width > 0 ? (p.X - b.X) / (double)b.Width : 0,
                y = b.Height > 0 ? (p.Y - b.Y) / (double)b.Height : 0,
                visible = inside,
            }, ct);
        }

        private void SendFrame(EncodedFrame frame, CancellationToken ct)
        {
            var packet = new byte[10 + frame.Data.Length];
            packet[0] = 1;
            packet[1] = (byte)(frame.IsKeyFrame ? 1 : 0);
            BinaryPrimitives.WriteInt64LittleEndian(packet.AsSpan(2), frame.Timestamp / 10);
            frame.Data.CopyTo(packet, 10);
            // 캡처 스레드에서 전송이 끝날 때까지 기다린다 → 네트워크가 느리면 자연히 프레임 수가 줄어든다
            SendAsync(packet, WebSocketMessageType.Binary, ct).GetAwaiter().GetResult();
        }

        private Task SendJsonAsync(object message, CancellationToken ct) =>
            SendAsync(JsonSerializer.SerializeToUtf8Bytes(message, Json), WebSocketMessageType.Text, ct);

        private async Task SendAsync(byte[] data, WebSocketMessageType type, CancellationToken ct)
        {
            await _sendLock.WaitAsync(ct);
            try
            {
                if (socket.State == WebSocketState.Open)
                    await socket.SendAsync(data, type, true, ct);
            }
            catch (WebSocketException)
            {
                await _cts.CancelAsync();
            }
            finally
            {
                _sendLock.Release();
            }
        }

        public void Dispose()
        {
            _cts.Dispose();
            _sendLock.Dispose();
            _inputQueue.Dispose();
        }
    }

    private static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
