using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Channels;

namespace PcManager.Agent.Launcher;

/// <summary>
/// 원격조작 전체 화면에서 Alt+Tab·Win·Alt+F4·Esc처럼 Windows·브라우저가 먼저 가져가는 키를 가로채 대시보드로 넘긴다 (RDP처럼).
/// 브라우저의 키보드 잠금(Keyboard Lock API)은 HTTPS 최상위 창에서만 되므로, HTTP 접속이나 다른 화면(iframe) 안에서도 되도록
/// 이 PC의 런처가 대신한다. 대시보드가 ws://127.0.0.1:{Port}/keys 로 연결해 있는 동안만,
/// 그리고 앞에 있는 창이 브라우저일 때만 저수준 키보드 후크로 그 키를 막고 {"code","down"} 으로 보낸다.
/// 연결은 이 PC 에이전트가 연결된 서버(대시보드)에서 연 페이지만 받는다 (Origin 확인).
/// </summary>
internal sealed class KeyboardRelay : IDisposable
{
    public const int Port = 47651;

    private static readonly string[] Browsers = ["chrome", "msedge", "firefox", "whale", "brave", "opera", "vivaldi"];

    private readonly Func<IEnumerable<string>> _allowedHosts;
    private readonly SynchronizationContext _ui;
    private readonly CancellationTokenSource _cts = new();
    private readonly ConcurrentDictionary<Guid, Channel<string>> _clients = new();
    private readonly TcpListener _listener = new(IPAddress.Loopback, Port);
    // 막은 키(가상 키 코드) → 보낸 코드. 떼는 키도 같이 막아 보낸다 (후크 스레드에서만 사용)
    private readonly Dictionary<int, string> _held = [];
    private readonly HookProc _proc;
    private IntPtr _hook;
    // 마지막으로 확인한 앞 창의 프로세스 (매번 프로세스를 찾지 않게)
    private int _lastPid;
    private bool _lastIsBrowser;

    /// <param name="allowedHosts">연결을 받을 대시보드 호스트 (이 PC 에이전트의 서버 주소)</param>
    public KeyboardRelay(Func<IEnumerable<string>> allowedHosts)
    {
        _allowedHosts = allowedHosts;
        _ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        _proc = HookCallback;
        try
        {
            _listener.Start();
        }
        catch (SocketException ex)
        {
            // 다른 세션의 런처가 이미 쓰는 중 등
            Trace.WriteLine($"키 전달 포트 {Port}를 열지 못했습니다: {ex.Message}");
            return;
        }
        _ = AcceptLoopAsync(_cts.Token);
    }

    private async Task AcceptLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await _listener.AcceptTcpClientAsync(ct);
            }
            catch (Exception ex) when (ex is OperationCanceledException or ObjectDisposedException or SocketException)
            {
                return;
            }
            _ = HandleAsync(client, ct);
        }
    }

    private async Task HandleAsync(TcpClient client, CancellationToken ct)
    {
        using (client)
        {
            var stream = client.GetStream();
            var headers = await ReadRequestAsync(stream, ct);
            if (headers is null)
                return;
            if (!headers.TryGetValue("sec-websocket-key", out var key) || !IsAllowedOrigin(headers.GetValueOrDefault("origin")))
            {
                await WriteAsync(stream, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", ct);
                return;
            }

            var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
            await WriteAsync(stream, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                $"Sec-WebSocket-Accept: {accept}\r\n\r\n", ct);
            using var socket = WebSocket.CreateFromStream(stream, new WebSocketCreationOptions
            {
                IsServer = true,
                KeepAliveInterval = TimeSpan.FromSeconds(20),
            });

            var id = Guid.NewGuid();
            var outbox = Channel.CreateBounded<string>(new BoundedChannelOptions(256) { FullMode = BoundedChannelFullMode.DropOldest });
            _clients[id] = outbox;
            UpdateHook();
            try
            {
                var sending = SendLoopAsync(socket, outbox.Reader, ct);
                // 받는 내용은 없다. 닫힐 때까지 기다린다
                var buffer = new byte[256];
                while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
                {
                    var result = await socket.ReceiveAsync(buffer, ct);
                    if (result.MessageType == WebSocketMessageType.Close)
                        break;
                }
                outbox.Writer.TryComplete();
                await sending;
            }
            catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or IOException)
            {
                // 브라우저가 닫음
            }
            finally
            {
                _clients.TryRemove(id, out _);
                UpdateHook();
            }
        }
    }

    private static async Task SendLoopAsync(WebSocket socket, ChannelReader<string> reader, CancellationToken ct)
    {
        await foreach (var text in reader.ReadAllAsync(ct))
        {
            if (socket.State != WebSocketState.Open)
                return;
            await socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, ct);
        }
    }

    /// <summary>HTTP 요청 헤더를 읽는다 (소문자 키). 너무 크거나 끊기면 null</summary>
    private static async Task<Dictionary<string, string>?> ReadRequestAsync(NetworkStream stream, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(5));
        var data = new List<byte>();
        var buffer = new byte[1024];
        try
        {
            while (data.Count < 8192)
            {
                var read = await stream.ReadAsync(buffer, timeout.Token);
                if (read == 0)
                    return null;
                data.AddRange(buffer.AsSpan(0, read));
                var text = Encoding.ASCII.GetString([.. data]);
                var end = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                if (end < 0)
                    continue;
                var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var line in text[..end].Split("\r\n").Skip(1))
                {
                    var colon = line.IndexOf(':');
                    if (colon > 0)
                        headers[line[..colon].Trim()] = line[(colon + 1)..].Trim();
                }
                return headers;
            }
        }
        catch (Exception ex) when (ex is OperationCanceledException or IOException)
        {
            // 시간 초과·끊김
        }
        return null;
    }

    private static Task WriteAsync(NetworkStream stream, string text, CancellationToken ct) =>
        stream.WriteAsync(Encoding.ASCII.GetBytes(text), ct).AsTask();

    private bool IsAllowedOrigin(string? origin)
    {
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri))
            return false;
        if (uri.IsLoopback)
            return true;
        return _allowedHosts().Any(h => string.Equals(h, uri.Host, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>연결된 대시보드가 있으면 후크를 걸고, 없으면 푼다 (후크는 메시지 루프가 있는 UI 스레드에서)</summary>
    private void UpdateHook()
    {
        var want = !_clients.IsEmpty;
        _ui.Post(_ =>
        {
            if (want && _hook == IntPtr.Zero)
            {
                _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(null), 0);
            }
            else if (!want && _hook != IntPtr.Zero)
            {
                UnhookWindowsHookEx(_hook);
                _hook = IntPtr.Zero;
                _held.Clear();
            }
        }, null);
    }

    private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && !_clients.IsEmpty)
        {
            var info = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            if ((info.flags & LLKHF_INJECTED) == 0)
            {
                var up = (info.flags & LLKHF_UP) != 0;
                string? code = null;
                if (up)
                {
                    if (_held.Remove(info.vkCode, out var held))
                        code = held;
                }
                else if (_held.TryGetValue(info.vkCode, out var repeat))
                {
                    code = repeat; // 길게 누름(자동 반복)
                }
                else if (Intercepted(info) is { } intercepted && ForegroundIsBrowser())
                {
                    code = intercepted;
                    _held[info.vkCode] = code;
                }

                if (code is not null)
                {
                    var text = $$"""{"code":"{{code}}","down":{{(up ? "false" : "true")}}}""";
                    foreach (var outbox in _clients.Values)
                        outbox.Writer.TryWrite(text);
                    return 1; // 이 PC에서는 막는다
                }
            }
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    /// <summary>원격으로 넘길 키면 KeyboardEvent.code. Windows·브라우저가 먼저 처리해 페이지에 오지 않는 키만</summary>
    private static string? Intercepted(KBDLLHOOKSTRUCT info)
    {
        var alt = (info.flags & LLKHF_ALTDOWN) != 0;
        return info.vkCode switch
        {
            VK_LWIN => "MetaLeft",
            VK_RWIN => "MetaRight",
            VK_TAB when alt => "Tab",
            // Esc: 전체 화면을 빠져나가지 않게 원격으로 (대시보드에서 길게 누르면 전체 화면 종료)
            VK_ESCAPE => "Escape",
            VK_F4 when alt => "F4",
            VK_SPACE when alt => "Space",
            _ => null,
        };
    }

    private bool ForegroundIsBrowser()
    {
        var window = GetForegroundWindow();
        if (window == IntPtr.Zero)
            return false;
        GetWindowThreadProcessId(window, out var pid);
        if (pid == _lastPid)
            return _lastIsBrowser;
        _lastPid = pid;
        try
        {
            using var process = Process.GetProcessById(pid);
            _lastIsBrowser = Browsers.Contains(process.ProcessName, StringComparer.OrdinalIgnoreCase);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            _lastIsBrowser = false;
        }
        return _lastIsBrowser;
    }

    public void Dispose()
    {
        _cts.Cancel();
        _listener.Stop();
        if (_hook != IntPtr.Zero)
        {
            UnhookWindowsHookEx(_hook);
            _hook = IntPtr.Zero;
        }
        _cts.Dispose();
    }

    private const int WH_KEYBOARD_LL = 13;
    private const int LLKHF_INJECTED = 0x10;
    private const int LLKHF_ALTDOWN = 0x20;
    private const int LLKHF_UP = 0x80;
    private const int VK_TAB = 0x09;
    private const int VK_ESCAPE = 0x1B;
    private const int VK_SPACE = 0x20;
    private const int VK_F4 = 0x73;
    private const int VK_LWIN = 0x5B;
    private const int VK_RWIN = 0x5C;

    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public int vkCode;
        public int scanCode;
        public int flags;
        public int time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
}
