using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using PcManager.Shared;

namespace PcManager.Agent.Linux.Remote;

/// <summary>
/// 원격조작/썸네일 도우미 (--remote-session URL [--thumb]). 서비스가 X11 세션 환경(DISPLAY·XAUTHORITY)으로 띄운다.
/// Windows 에이전트와 같은 규약으로 서버 WebSocket에 붙는다 (대시보드는 Windows/Linux를 구별하지 않는다).
///
/// 보내는 메시지
///   바이너리: [0]=1(영상) [1]=1(키 프레임) [2..9]=타임스탬프(µs, LE) [10..]=H.264 Annex B
///             [0]=2(썸네일) [1..4]=마지막 화면 변화 후 초(int32 LE) [5..]=JPEG
///   텍스트: hello(모니터 목록, clipDir), format(인코딩 크기), cursor, clipboard, clipfiles(복사한 파일 경로), status, error
/// 받는 메시지 (JSON, t): m md mu w kd ku combo text reset clip clipfiles monitor view keyframe quality
/// </summary>
internal static class RemoteSessionApp
{
    public static int Run(string url, bool thumbnail)
    {
        try
        {
            return RunAsync(new Uri(url), thumbnail).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            // 서비스가 띄운 창 없는 프로세스: 오류를 볼 곳이 없어 임시 폴더에 남긴다
            try
            {
                File.AppendAllText(Path.Combine(Path.GetTempPath(), "pcmanager-remote.log"),
                    $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {(thumbnail ? "썸네일" : "원격조작")} 오류: {ex}{Environment.NewLine}");
            }
            catch (IOException)
            {
            }
            return 1;
        }
    }

    private static async Task<int> RunAsync(Uri url, bool thumbnail)
    {
        using var socket = new ClientWebSocket();
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
        var token = Environment.GetEnvironmentVariable(LinuxRemoteControl.TokenVariable);
        if (!string.IsNullOrEmpty(token))
            socket.Options.SetRequestHeader(AgentHeaders.Token, token);
        using (var connectTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(15)))
            await socket.ConnectAsync(url, connectTimeout.Token);

        var display = Environment.GetEnvironmentVariable("DISPLAY") ?? ":0";
        var channel = new SocketChannel(socket);
        if (thumbnail)
            await new ThumbnailSession(channel, display).RunAsync();
        else
            await new RemoteSession(channel, display).RunAsync();
        return 0;
    }
}

/// <summary>WebSocket 송신 직렬화 (영상·커서·응답이 여러 스레드에서 보낸다)</summary>
internal sealed class SocketChannel(ClientWebSocket socket)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly SemaphoreSlim _sendLock = new(1, 1);

    public ClientWebSocket Socket => socket;

    public Task SendJsonAsync(object message, CancellationToken ct) =>
        SendAsync(JsonSerializer.SerializeToUtf8Bytes(message, Json), WebSocketMessageType.Text, ct);

    public async Task SendAsync(byte[] data, WebSocketMessageType type, CancellationToken ct)
    {
        await _sendLock.WaitAsync(ct);
        try
        {
            if (socket.State == WebSocketState.Open)
                await socket.SendAsync(data, type, true, ct);
        }
        finally
        {
            _sendLock.Release();
        }
    }

    /// <summary>텍스트 메시지 하나를 받는다. 연결이 닫히면 null</summary>
    public async Task<string?> ReceiveTextAsync(CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close)
                return null;
            message.Write(buffer, 0, result.Count);
            if (result.EndOfMessage)
                return result.MessageType == WebSocketMessageType.Text ? Encoding.UTF8.GetString(message.ToArray()) : "";
        }
    }
}

/// <summary>원격조작 한 세션: 영상 송신 + 입력 수신</summary>
internal sealed class RemoteSession(SocketChannel channel, string display)
{
    private const int Fps = 30;
    private const int MaxEncodeWidth = 2560;

    private readonly List<Monitor> _monitors = Monitors.List();
    private readonly BlockingCollection<Action<InputInjector>> _input = new(1000);
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private volatile int _monitorIndex = -1;
    private volatile int _bitrate = 6_000_000;
    private (int Width, int Height)? _view;
    private CancellationTokenSource? _capture;
    private CancellationTokenSource? _viewDebounce;
    private string? _lastClipboard;
    // 파일 목록: 마지막으로 넣은/읽은 목록 (서로 되돌려 보내지 않도록)
    private string? _lastClipFiles;

    /// <summary>다른 PC에서 복사한 파일을 붙여넣을 때 서버가 받아 두는 곳 (대시보드가 이 아래 새 폴더로 복사)</summary>
    internal const string ClipboardFolder = "/tmp/pcmanager-clip";

    // 파일 관리자가 복사한 파일을 클립보드에 두는 형식 (GNOME Files 등 / 일반)
    internal const string GnomeFilesTarget = "x-special/gnome-copied-files";
    private const string UriListTarget = "text/uri-list";

    private Monitor Current =>
        _monitors.FirstOrDefault(m => m.Index == _monitorIndex) ?? _monitors.First(m => m.Primary);

    public async Task RunAsync()
    {
        if (_monitors.Count == 0)
        {
            await channel.SendJsonAsync(new { type = "error", message = "X 화면을 찾지 못했습니다." }, CancellationToken.None);
            return;
        }
        using var stop = new CancellationTokenSource();
        var ct = stop.Token;

        await channel.SendJsonAsync(new
        {
            type = "hello",
            monitors = _monitors.Select(m => new { index = m.Index, name = m.Name, primary = m.Primary, x = m.X, y = m.Y, width = m.Width, height = m.Height }),
            desktop = (string?)null,
            clipDir = ClipboardFolder,
        }, ct);
        _ = Task.Run(CleanupClipboardFolder);

        var inputThread = new Thread(InputLoop) { IsBackground = true, Name = "input" };
        inputThread.Start();
        var video = VideoLoopAsync(ct);
        var cursor = CursorLoopAsync(ct);
        var clipboard = ClipboardLoopAsync(ct);

        try
        {
            await ReceiveLoopAsync(ct);
        }
        finally
        {
            // 정리(ffmpeg 종료·입력 스레드)가 어떤 이유로 막혀도 프로세스는 끝낸다
            _ = Task.Delay(TimeSpan.FromSeconds(5)).ContinueWith(_ => Environment.Exit(0), TaskScheduler.Default);
            await stop.CancelAsync();
            RestartCapture();
            _input.CompleteAdding();
            await Task.WhenAll(video, cursor, clipboard).ContinueWith(_ => { });
            inputThread.Join(2000);
        }
    }

    // ── 영상

    private async Task VideoLoopAsync(CancellationToken ct)
    {
        var failures = 0;
        while (!ct.IsCancellationRequested)
        {
            var monitor = Current;
            var (width, height) = EncodeSize(monitor);
            using var capture = CancellationTokenSource.CreateLinkedTokenSource(ct);
            _capture = capture;
            H264Capture? encoder = null;
            try
            {
                encoder = new H264Capture(display, monitor, width, height, Fps, _bitrate);
                await channel.SendJsonAsync(new
                {
                    type = "format", width, height,
                    monitor = new { x = monitor.X, y = monitor.Y, width = monitor.Width, height = monitor.Height },
                    capture = "x11grab", encoder = "x264",
                }, ct);

                var frames = 0;
                while (await encoder.ReadFrameAsync(capture.Token) is { } frame)
                {
                    frames++;
                    var packet = new byte[10 + frame.Data.Length];
                    packet[0] = 1;
                    packet[1] = (byte)(frame.IsKeyFrame ? 1 : 0);
                    BinaryPrimitives.WriteInt64LittleEndian(packet.AsSpan(2), _clock.Elapsed.Ticks / 10);
                    frame.Data.CopyTo(packet, 10);
                    await channel.SendAsync(packet, WebSocketMessageType.Binary, ct);
                }
                // ffmpeg가 스스로 끝남 (화면 크기 변경 등)
                if (frames == 0 && ++failures >= 3)
                {
                    await channel.SendJsonAsync(new { type = "error", message = "화면 캡처 실패: " + (encoder.LastError ?? "ffmpeg 종료") }, ct);
                    await Task.Delay(TimeSpan.FromSeconds(5), ct);
                }
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                // 다시 시작 요청 (모니터·크기·화질 변경, 키 프레임)
                failures = 0;
            }
            catch (System.ComponentModel.Win32Exception)
            {
                await channel.SendJsonAsync(new { type = "error", message = "ffmpeg가 없습니다. sudo apt install ffmpeg" }, ct);
                return;
            }
            finally
            {
                encoder?.Dispose();
            }
        }
    }

    /// <summary>인코딩 크기: 원래 크기 이하, 보는 창에 맞춤, 짝수</summary>
    private (int Width, int Height) EncodeSize(Monitor monitor)
    {
        double scale = 1;
        if (_view is { } view && view.Width > 0 && view.Height > 0)
            scale = Math.Min(1, Math.Min((double)view.Width / monitor.Width, (double)view.Height / monitor.Height));
        else if (monitor.Width > MaxEncodeWidth)
            scale = 0.5;
        var width = Math.Max(2, (int)(monitor.Width * scale) & ~1);
        var height = Math.Max(2, (int)(monitor.Height * scale) & ~1);
        return (width, height);
    }

    private void RestartCapture()
    {
        try
        {
            _capture?.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // 방금 끝난 캡처
        }
    }

    // ── 입력

    private async Task ReceiveLoopAsync(CancellationToken ct)
    {
        while (channel.Socket.State == WebSocketState.Open)
        {
            string? text;
            try
            {
                text = await channel.ReceiveTextAsync(ct);
            }
            catch (WebSocketException)
            {
                return;
            }
            if (text is null)
                return;
            if (text.Length == 0)
                continue;
            try
            {
                using var doc = JsonDocument.Parse(text);
                Handle(doc.RootElement);
            }
            catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
            {
                // 알 수 없는 메시지는 무시
            }
        }
    }

    private void Handle(JsonElement root)
    {
        var type = root.GetProperty("t").GetString();
        switch (type)
        {
            case "m":
            {
                var (x, y) = (root.GetProperty("x").GetDouble(), root.GetProperty("y").GetDouble());
                var monitor = Current;
                Enqueue(i => i.Move(monitor, x, y));
                break;
            }
            case "md" or "mu":
            {
                var (x, y, b) = (root.GetProperty("x").GetDouble(), root.GetProperty("y").GetDouble(), root.GetProperty("b").GetInt32());
                var monitor = Current;
                var down = type == "md";
                Enqueue(i => { i.Move(monitor, x, y); i.Button(b, down); });
                break;
            }
            case "w":
            {
                var dx = root.TryGetProperty("dx", out var vx) ? vx.GetInt32() : 0;
                var dy = root.TryGetProperty("dy", out var vy) ? vy.GetInt32() : 0;
                Enqueue(i => i.Wheel(dx, dy));
                break;
            }
            case "kd" or "ku":
            {
                var code = root.GetProperty("code").GetString() ?? "";
                var key = root.TryGetProperty("key", out var k) ? k.GetString() : null;
                // 한/영·한자 키: 브라우저에 따라 code가 아니라 key로만 온다
                code = key switch { "HangulMode" => "Lang1", "HanjaMode" => "Lang2", _ => code };
                var down = type == "kd";
                var (shift, ctrl, alt, meta) = (Flag(root, "shift"), Flag(root, "ctrl"), Flag(root, "alt"), Flag(root, "meta"));
                Enqueue(i => i.Key(code, down, shift, ctrl, alt, meta));
                break;
            }
            case "combo":
            {
                var codes = root.GetProperty("codes").EnumerateArray().Select(c => c.GetString() ?? "").ToList();
                Enqueue(i => i.Combo(codes));
                break;
            }
            case "reset":
                Enqueue(i => i.Reset());
                break;
            case "text":
                TypeText(root.GetProperty("text").GetString() ?? "");
                break;
            case "clip":
                SetClipboard(root.GetProperty("text").GetString() ?? "");
                break;
            case "clipfiles":
            {
                var paths = root.GetProperty("paths").EnumerateArray().Select(p => p.GetString() ?? "").Where(p => p.Length > 0).ToList();
                if (paths.Count > 0)
                    SetClipboardFiles(paths);
                break;
            }
            case "monitor":
                _monitorIndex = root.GetProperty("index").GetInt32();
                RestartCapture();
                break;
            case "view":
                OnView(root.GetProperty("width").GetInt32(), root.GetProperty("height").GetInt32());
                break;
            case "keyframe":
                // x264는 2초마다 키 프레임을 넣지만, 요청이 오면 바로 주도록 인코더를 다시 시작
                RestartCapture();
                break;
            case "quality":
                _bitrate = Math.Clamp(root.GetProperty("bitrate").GetInt32(), 500_000, 30_000_000);
                RestartCapture();
                break;
        }
    }

    private static bool Flag(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;

    private void Enqueue(Action<InputInjector> action) => _input.TryAdd(action);

    private void InputLoop()
    {
        using var injector = new InputInjector();
        foreach (var action in _input.GetConsumingEnumerable())
        {
            try
            {
                action(injector);
            }
            catch (Exception ex) when (ex is InvalidOperationException or ArgumentException)
            {
            }
        }
    }

    /// <summary>보는 창 크기가 바뀌면 인코딩 크기를 맞춘다 (창 크기 조절 중에는 잠시 기다렸다가)</summary>
    private void OnView(int width, int height)
    {
        var previous = EncodeSize(Current);
        _view = (width, height);
        if (EncodeSize(Current) == previous)
            return;
        _viewDebounce?.Cancel();
        var debounce = _viewDebounce = new CancellationTokenSource();
        _ = Task.Delay(400, debounce.Token).ContinueWith(t => { if (!t.IsCanceled) RestartCapture(); }, TaskScheduler.Default);
    }

    /// <summary>문자열 입력 (붙여넣기 등): xdotool type</summary>
    private static void TypeText(string text)
    {
        RunTool("xdotool", ["type", "--clearmodifiers", "--delay", "2", "--", text.Replace("\r\n", "\n")], null);
    }

    // ── 커서·클립보드

    private async Task CursorLoopAsync(CancellationToken ct)
    {
        var x11 = X11.XOpenDisplay(null);
        if (x11 == IntPtr.Zero)
            return;
        try
        {
            var root = X11.XDefaultRootWindow(x11);
            (int, int)? last = null;
            while (!ct.IsCancellationRequested)
            {
                if (X11.XQueryPointer(x11, root, out _, out _, out var px, out var py, out _, out _, out _) && last != (px, py))
                {
                    last = (px, py);
                    var m = Current;
                    var visible = px >= m.X && px < m.X + m.Width && py >= m.Y && py < m.Y + m.Height;
                    await channel.SendJsonAsync(new
                    {
                        type = "cursor",
                        x = (double)(px - m.X) / Math.Max(1, m.Width - 1),
                        y = (double)(py - m.Y) / Math.Max(1, m.Height - 1),
                        visible,
                    }, ct);
                }
                await Task.Delay(40, ct);
            }
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            X11.XCloseDisplay(x11);
        }
    }

    /// <summary>원격 PC 클립보드가 바뀌면 보낸다 (xclip, 없으면 생략)</summary>
    private async Task ClipboardLoopAsync(CancellationToken ct)
    {
        try
        {
            var first = true;
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(600, ct);
                // 복사한 파일: 경로만 알린다. 세션을 열 때 이미 있던 목록은 알리지 않는다
                if (ReadClipboardFiles() is { Count: > 0 } files)
                {
                    var key = string.Join('\n', files);
                    if (key != _lastClipFiles)
                    {
                        _lastClipFiles = key;
                        if (!first)
                            await channel.SendJsonAsync(new { type = "clipfiles", paths = files.Take(1000) }, ct);
                    }
                    first = false;
                    continue;
                }
                first = false;
                var text = RunTool("xclip", ["-selection", "clipboard", "-o"], null, capture: true);
                if (text is null)
                    return; // xclip 없음
                if (text.Length > 0 && text.Length <= 256 * 1024 && text != _lastClipboard)
                {
                    _lastClipboard = text;
                    await channel.SendJsonAsync(new { type = "clipboard", text }, ct);
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    /// <summary>클립보드의 파일 목록 (GNOME Files 형식 또는 text/uri-list). 파일이 아니면 null</summary>
    private static List<string>? ReadClipboardFiles()
    {
        var targets = RunTool("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], null, capture: true);
        if (string.IsNullOrEmpty(targets))
            return null;
        var list = targets.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        var target = list.Contains(GnomeFilesTarget) ? GnomeFilesTarget : list.Contains(UriListTarget) ? UriListTarget : null;
        if (target is null)
            return null;
        var content = RunTool("xclip", ["-selection", "clipboard", "-t", target, "-o"], null, capture: true) ?? "";
        var files = new List<string>();
        foreach (var line in content.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            // GNOME 형식은 첫 줄이 copy/cut, uri-list는 #으로 시작하는 줄이 주석
            if (line.StartsWith('#') || !Uri.TryCreate(line, UriKind.Absolute, out var uri) || !uri.IsFile)
                continue;
            files.Add(uri.LocalPath);
        }
        return files;
    }

    /// <summary>받아 둔 파일들을 '복사'로 클립보드에 넣는다 (GNOME Files에서 Ctrl+V로 붙여넣기)</summary>
    private void SetClipboardFiles(List<string> paths)
    {
        _lastClipFiles = string.Join('\n', paths);
        var content = "copy\n" + string.Join('\n', paths.Select(p => new Uri(p).AbsoluteUri));
        RunTool("xclip", ["-selection", "clipboard", "-t", GnomeFilesTarget, "-i"], content);
    }

    /// <summary>하루 넘은 붙여넣기용 임시 폴더를 지운다</summary>
    private static void CleanupClipboardFolder()
    {
        try
        {
            if (!Directory.Exists(ClipboardFolder))
                return;
            foreach (var dir in Directory.GetDirectories(ClipboardFolder))
            {
                if (DateTime.UtcNow - Directory.GetLastWriteTimeUtc(dir) > TimeSpan.FromDays(1))
                    Directory.Delete(dir, recursive: true);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    private void SetClipboard(string text)
    {
        if (text == _lastClipboard)
            return;
        _lastClipboard = text;
        RunTool("xclip", ["-selection", "clipboard", "-i"], text);
    }

    /// <returns>capture면 표준 출력, 아니면 ""; 프로그램이 없으면 null</returns>
    private static string? RunTool(string file, string[] args, string? stdin, bool capture = false)
    {
        try
        {
            var info = new ProcessStartInfo(file)
            {
                UseShellExecute = false,
                RedirectStandardInput = stdin is not null,
                RedirectStandardOutput = capture,
                RedirectStandardError = true,
            };
            foreach (var a in args)
                info.ArgumentList.Add(a);
            using var process = Process.Start(info);
            if (process is null)
                return null;
            if (stdin is not null)
            {
                process.StandardInput.Write(stdin);
                process.StandardInput.Close();
            }
            var output = capture ? process.StandardOutput.ReadToEnd() : "";
            process.WaitForExit(3000);
            return output;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return null;
        }
    }
}

/// <summary>썸네일: 3초마다 주 모니터를 작은 JPEG로 보내고, 마지막으로 화면이 바뀐 뒤 몇 초인지 알린다</summary>
internal sealed class ThumbnailSession(SocketChannel channel, string display)
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(3);
    private const int GrayWidth = 64;
    private const int GrayHeight = 36;

    public async Task RunAsync()
    {
        using var stop = new CancellationTokenSource();
        var ct = stop.Token;
        var monitor = Monitors.List().FirstOrDefault(m => m.Primary);
        if (monitor is null)
        {
            await channel.SendJsonAsync(new { type = "error", message = "X 화면을 찾지 못했습니다." }, ct);
            return;
        }
        await channel.SendJsonAsync(new { type = "hello", width = monitor.Width, height = monitor.Height, desktop = (string?)null }, ct);

        // 서버는 아무것도 보내지 않는다: 닫힐 때까지 받아 버린다
        var drain = Task.Run(async () =>
        {
            try
            {
                while (await channel.ReceiveTextAsync(CancellationToken.None) is not null)
                {
                }
            }
            catch (WebSocketException)
            {
            }
            await stop.CancelAsync();
        });

        byte[]? lastGray = null;
        var lastChange = Stopwatch.StartNew();
        var grayPath = Path.Combine(Path.GetTempPath(), $"pcm-thumb-{Environment.ProcessId}.gray");
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var jpeg = Capture(monitor, grayPath);
                if (jpeg is not null)
                {
                    var gray = File.Exists(grayPath) ? await File.ReadAllBytesAsync(grayPath, ct) : null;
                    if (lastGray is null || gray is null || Changed(lastGray, gray))
                        lastChange.Restart();
                    lastGray = gray ?? lastGray;

                    var packet = new byte[5 + jpeg.Length];
                    packet[0] = 2;
                    BinaryPrimitives.WriteInt32LittleEndian(packet.AsSpan(1), (int)lastChange.Elapsed.TotalSeconds);
                    jpeg.CopyTo(packet, 5);
                    await channel.SendAsync(packet, WebSocketMessageType.Binary, ct);
                }
                await Task.Delay(Interval, ct);
            }
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            File.Delete(grayPath);
            await drain;
        }
    }

    /// <summary>ffmpeg 한 번으로 JPEG(폭 320)와 변화 감지용 작은 회색 이미지를 함께 만든다</summary>
    private byte[]? Capture(Monitor monitor, string grayPath)
    {
        var info = new ProcessStartInfo("ffmpeg")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var arg in new[]
        {
            "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "x11grab", "-draw_mouse", "0", "-video_size", $"{monitor.Width}x{monitor.Height}",
            "-i", $"{display}+{monitor.X},{monitor.Y}",
            "-filter_complex", $"[0:v]split=2[a][b];[a]scale=320:-2[j];[b]scale={GrayWidth}:{GrayHeight},format=gray[g]",
            "-map", "[j]", "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "5", "pipe:1",
            "-map", "[g]", "-frames:v", "1", "-f", "rawvideo", "-y", grayPath,
        })
            info.ArgumentList.Add(arg);
        try
        {
            using var process = Process.Start(info);
            if (process is null)
                return null;
            using var output = new MemoryStream();
            process.StandardOutput.BaseStream.CopyTo(output);
            process.StandardError.ReadToEnd();
            process.WaitForExit(5000);
            return output.Length > 0 ? output.ToArray() : null;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return null;
        }
    }

    /// <summary>Windows와 같은 기준: 아래 1/20(작업 표시줄) 제외, 24 넘게 달라진 화소가 0.3% 넘으면 변화</summary>
    private static bool Changed(byte[] a, byte[] b)
    {
        if (a.Length != b.Length)
            return true;
        var rows = GrayHeight - Math.Max(1, GrayHeight / 20);
        var count = 0;
        for (var i = 0; i < rows * GrayWidth; i++)
            if (Math.Abs(a[i] - b[i]) > 24)
                count++;
        return count > rows * GrayWidth * 3 / 1000;
    }
}
