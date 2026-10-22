using System.Diagnostics;
using System.Net.Sockets;
using System.Text.Json;
using static PcManager.Agent.Linux.Launcher.Gtk;

namespace PcManager.Agent.Linux.Launcher;

/// <summary>
/// 런처 창 (--launcher [--minimized]): Windows 런처 창과 같은 내용 — 연결 상태, 서버 주소, 연결/끊기, 업데이트,
/// 대시보드 열기, 에이전트 시작/종료. 로그인 사용자 권한으로 돌고 서비스(root)와는 Unix 소켓으로 말한다.
/// Ubuntu 독에는 트레이가 없으므로 닫기(X)는 최소화 — 창이 떠 있는 동안 독 왼쪽에 실행 중 표시가 남는다
/// </summary>
internal sealed class LauncherApp
{
    private static readonly TimeSpan StatusTimeout = TimeSpan.FromSeconds(3);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private const string ServiceUnavailableMessage = "에이전트 서비스가 실행 중이 아닙니다";

    private const string ConnectedColor = "#22a05a";
    private const string ConnectingColor = "#e6a01e";
    private const string DisconnectedColor = "#8c929c";
    private const string ErrorColor = "#d23c3c";

    private readonly bool _minimized;
    private IntPtr _app;
    private IntPtr _window;
    private IntPtr _statusDot, _statusText, _statusDetail, _start;
    private IntPtr _runningPanel, _serverUrl, _connect, _disconnect, _info, _update, _dashboard, _stop;
    private IntPtr _error;

    private LocalStatus? _status;
    private bool _serviceOff = true;
    private bool _serverEdited;
    private bool _settingServerText;
    private string? _busyCommand;
    private bool _refreshing;
    private bool _firstStatus = true;

    private LauncherApp(bool minimized) => _minimized = minimized;

    public static int Run(bool minimized)
    {
        try
        {
            // 창 WM_CLASS = 앱 ID → 독이 .desktop(아이콘·이름)과 묶는다
            g_set_prgname(DesktopIntegration.AppId);
            var launcher = new LauncherApp(minimized);
            launcher._app = gtk_application_new(DesktopIntegration.AppId, 0);
            On(launcher._app, "activate", launcher.OnActivate);
            var code = g_application_run(launcher._app, 0, IntPtr.Zero);
            g_object_unref(launcher._app);
            return code;
        }
        catch (DllNotFoundException ex)
        {
            Console.Error.WriteLine($"GTK 3(libgtk-3)가 없어 창을 띄울 수 없습니다. 데스크톱 환경에서 실행하세요. ({ex.Message})");
            return 1;
        }
    }

    /// <summary>처음 실행이면 창을 만들고, 이미 떠 있는데 다시 실행되면(앱 목록·독 클릭) 창을 앞으로</summary>
    private void OnActivate()
    {
        if (_window != IntPtr.Zero)
        {
            gtk_window_present(_window);
            return;
        }
        BuildWindow();
        gtk_widget_show_all(_window);
        ApplyStatus(null, null);
        if (_minimized)
            gtk_window_iconify(_window);
        else
            gtk_window_present(_window);

        Every(TimeSpan.FromSeconds(2), () =>
        {
            Refresh();
            return true;
        });
        Refresh();
    }

    private void BuildWindow()
    {
        _window = gtk_application_window_new(_app);
        gtk_window_set_title(_window, "PC Manager 에이전트");
        gtk_window_set_resizable(_window, false);
        if (File.Exists(DesktopIntegration.IconPath))
            gtk_window_set_icon_from_file(_window, DesktopIntegration.IconPath, IntPtr.Zero);
        gtk_container_set_border_width(_window, 16);
        // 닫기(X)는 최소화 (에이전트는 계속 실행, 독에 남음). 완전히 끄려면 [에이전트 종료]
        OnDelete(_window, () =>
        {
            gtk_window_iconify(_window);
            return true;
        });

        var layout = gtk_box_new(OrientationVertical, 4);
        gtk_container_add(_window, layout);

        var statusRow = gtk_box_new(OrientationHorizontal, 6);
        _statusDot = gtk_label_new(null);
        _statusText = gtk_label_new(null);
        gtk_box_pack_start(statusRow, _statusDot, false, false, 0);
        gtk_box_pack_start(statusRow, _statusText, false, false, 0);
        gtk_box_pack_start(layout, statusRow, false, false, 0);

        _statusDetail = WrappedLabel();
        gtk_box_pack_start(layout, _statusDetail, false, false, 0);

        _start = gtk_button_new_with_label("에이전트 시작");
        gtk_widget_set_halign(_start, AlignStart);
        gtk_box_pack_start(layout, _start, false, false, 10);

        _runningPanel = gtk_box_new(OrientationVertical, 6);
        gtk_widget_set_size_request(_runningPanel, 340, -1);
        var serverLabel = gtk_label_new("서버 주소");
        gtk_label_set_xalign(serverLabel, 0);
        gtk_box_pack_start(_runningPanel, serverLabel, false, false, 6);
        _serverUrl = gtk_entry_new();
        gtk_entry_set_placeholder_text(_serverUrl, "예: 192.168.0.10:5063");
        gtk_box_pack_start(_runningPanel, _serverUrl, false, false, 0);

        var buttons = gtk_box_new(OrientationHorizontal, 6);
        _connect = gtk_button_new_with_label("연결");
        _disconnect = gtk_button_new_with_label("끊기");
        gtk_widget_set_size_request(_connect, 88, -1);
        gtk_widget_set_size_request(_disconnect, 88, -1);
        gtk_box_pack_start(buttons, _connect, false, false, 0);
        gtk_box_pack_start(buttons, _disconnect, false, false, 0);
        gtk_box_pack_start(_runningPanel, buttons, false, false, 0);

        gtk_box_pack_start(_runningPanel, gtk_separator_new(OrientationHorizontal), false, false, 8);
        _info = gtk_label_new(null);
        gtk_label_set_xalign(_info, 0);
        gtk_label_set_selectable(_info, true);
        gtk_box_pack_start(_runningPanel, _info, false, false, 0);

        var bottomRow = gtk_box_new(OrientationHorizontal, 6);
        _update = gtk_button_new_with_label("업데이트");
        gtk_widget_set_no_show_all(_update, true);
        _dashboard = LinkButton("대시보드 열기");
        _stop = LinkButton("에이전트 종료");
        gtk_box_pack_start(bottomRow, _update, false, false, 0);
        gtk_box_pack_start(bottomRow, _dashboard, false, false, 0);
        gtk_box_pack_start(bottomRow, _stop, false, false, 0);
        gtk_box_pack_start(_runningPanel, bottomRow, false, false, 4);
        gtk_box_pack_start(layout, _runningPanel, false, false, 0);

        _error = WrappedLabel();
        gtk_box_pack_start(layout, _error, false, false, 4);

        On(_serverUrl, "changed", () =>
        {
            if (!_settingServerText)
                _serverEdited = true;
        });
        On(_serverUrl, "activate", Connect); // Enter
        On(_connect, "clicked", Connect);
        On(_disconnect, "clicked", () => Fire(() => Send(new LocalRequest(LocalControl.DisconnectCommand), StatusTimeout)));
        On(_update, "clicked", () => Fire(() => Send(new LocalRequest(LocalControl.UpdateCommand), TimeSpan.FromMinutes(3))));
        On(_dashboard, "clicked", OpenDashboard);
        On(_stop, "clicked", () => Fire(StopAgent));
        On(_start, "clicked", () => Fire(StartAgent));
    }

    private static IntPtr WrappedLabel()
    {
        var label = gtk_label_new(null);
        gtk_label_set_xalign(label, 0);
        gtk_label_set_line_wrap(label, true);
        gtk_label_set_max_width_chars(label, 44);
        return label;
    }

    private static IntPtr LinkButton(string text)
    {
        var button = gtk_button_new_with_label(text);
        gtk_button_set_relief(button, ReliefNone);
        return button;
    }

    private void Connect() => Fire(() => Send(new LocalRequest(LocalControl.ConnectCommand, GetEntryText(_serverUrl)), TimeSpan.FromSeconds(20)));

    private void Fire(Action action)
    {
        SetError("");
        action();
    }

    // ───── 서비스 요청 (백그라운드 스레드 → 결과는 GTK 스레드로) ─────

    private void Refresh()
    {
        if (_refreshing)
            return;
        _refreshing = true;
        _ = Task.Run(async () =>
        {
            var response = await SendAsync(new LocalRequest(LocalControl.StatusCommand), StatusTimeout);
            Post(() =>
            {
                _refreshing = false;
                Apply(response);
                // 서버 주소가 아직 없으면 창을 띄워 입력을 받는다 (자동 실행으로 최소화돼 떴어도)
                if (_firstStatus && response.Status?.Status == ConnectionStatus.NotConfigured)
                    gtk_window_present(_window);
                _firstStatus = false;
            });
        });
    }

    private void Send(LocalRequest request, TimeSpan timeout, Action<LocalResponse>? after = null)
    {
        SetBusy(request.Command);
        _ = Task.Run(async () =>
        {
            var response = await SendAsync(request, timeout);
            Post(() =>
            {
                SetBusy(null);
                Apply(response);
                if (!response.Ok && response.Error is not null)
                    SetError(response.Error);
                after?.Invoke(response);
            });
        });
    }

    /// <returns>서비스에 닿지 못하면 Ok=false, Status=null</returns>
    private static async Task<LocalResponse> SendAsync(LocalRequest request, TimeSpan timeout)
    {
        using var cancel = new CancellationTokenSource(timeout);
        try
        {
            using var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            await socket.ConnectAsync(new UnixDomainSocketEndPoint(LocalControl.UnixSocketPath), cancel.Token);
            await using var stream = new NetworkStream(socket, ownsSocket: false);
            using var reader = new StreamReader(stream, leaveOpen: true);
            await using var writer = new StreamWriter(stream, leaveOpen: true) { AutoFlush = true };
            await writer.WriteLineAsync(JsonSerializer.Serialize(request, Json));

            var line = await reader.ReadLineAsync(cancel.Token);
            return (line is null ? null : JsonSerializer.Deserialize<LocalResponse>(line, Json))
                ?? new LocalResponse(false, "에이전트 서비스 응답이 없습니다", null);
        }
        catch (OperationCanceledException)
        {
            return new LocalResponse(false, ServiceUnavailableMessage, null);
        }
        catch (Exception ex) when (ex is SocketException or IOException or UnauthorizedAccessException or JsonException)
        {
            return new LocalResponse(false, $"{ServiceUnavailableMessage} ({ex.Message})", null);
        }
    }

    /// <summary>에이전트 서비스를 멈추고 런처도 닫는다 (Windows와 같음)</summary>
    private void StopAgent() => Send(new LocalRequest(LocalControl.StopCommand), StatusTimeout, response =>
    {
        if (response.Ok || response.Status is null)
            g_application_quit(_app);
    });

    /// <summary>멈춘 서비스를 다시 시작한다 (관리자 암호 창: pkexec)</summary>
    private void StartAgent()
    {
        SetBusy("start");
        _ = Task.Run(() =>
        {
            string? error = null;
            try
            {
                using var process = Process.Start("pkexec", ["systemctl", "start", LinuxAgentHost.ServiceName]);
                process?.WaitForExit();
                if (process is { ExitCode: not 0 and not 126 })  // 126 = 암호 창 취소
                    error = $"시작 실패 (종료 코드 {process.ExitCode}). 터미널에서: sudo systemctl start {LinuxAgentHost.ServiceName}";
            }
            catch (System.ComponentModel.Win32Exception ex)
            {
                error = $"시작 실패: {ex.Message}. 터미널에서: sudo systemctl start {LinuxAgentHost.ServiceName}";
            }
            Post(() =>
            {
                SetBusy(null);
                // 실패 이유는 남겨 둔다 (상태 갱신은 꺼진 상태에서 오류를 지우므로 성공했을 때만)
                if (error is not null)
                    SetError(error);
                else
                    Refresh();
            });
        });
    }

    private void OpenDashboard()
    {
        // 서버가 알려준 HTTPS 주소 우선 (원격조작 키보드 잠금은 HTTPS에서만)
        var url = _status?.DashboardUrl ?? _status?.ServerUrl;
        // 이 PC가 연 대시보드임을 알려 Remote 화면에서 자기 PC를 숨기게 한다
        if (!string.IsNullOrWhiteSpace(url) && _status?.MachineName is { Length: > 0 } self)
            url = $"{url.TrimEnd('/')}/?pc={Uri.EscapeDataString(self)}";
        if (string.IsNullOrWhiteSpace(url))
            return;
        try
        {
            Process.Start("xdg-open", [url])?.Dispose();
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            SetError($"브라우저를 열지 못했습니다: {ex.Message}");
        }
    }

    // ───── 화면 갱신 (GTK 스레드) ─────

    private void SetBusy(string? command)
    {
        _busyCommand = command;
        gtk_button_set_label(_connect, command == LocalControl.ConnectCommand ? "연결 중…" : "연결");
        gtk_button_set_label(_start, command == "start" ? "시작 중…" : "에이전트 시작");
        UpdateButtons();
    }

    private void SetError(string message) =>
        gtk_label_set_markup(_error, message.Length == 0 ? "" : $"<span foreground=\"{ErrorColor}\">{Escape(message)}</span>");

    private void Apply(LocalResponse response) => ApplyStatus(response.Status, response.Ok ? null : response.Error);

    private void ApplyStatus(LocalStatus? status, string? error)
    {
        _status = status;
        _serviceOff = status is null;
        var (color, title, detail) = status?.Status switch
        {
            ConnectionStatus.Connected => (ConnectedColor, "연결됨", status.ServerUrl),
            ConnectionStatus.Connecting => (ConnectingColor, "연결 중…", status.LastError is null ? status.ServerUrl : $"재시도 중: {status.LastError}"),
            ConnectionStatus.Disconnected => (DisconnectedColor, "연결 끊김", "서버 주소를 확인하고 [연결]을 누르세요"),
            ConnectionStatus.NotConfigured => (DisconnectedColor, "서버에 연결되지 않음", "서버 주소를 입력하고 [연결]을 누르세요"),
            _ => (ErrorColor, "에이전트 꺼짐", "에이전트가 중지되었습니다. [에이전트 시작]을 누르세요."),
        };
        gtk_label_set_markup(_statusDot, $"<span size=\"x-large\" foreground=\"{color}\">●</span>");
        var titleText = status?.Updating == true
            ? (status.UpdateNote is { } note ? $"업데이트 중… {note}" : "업데이트 중…")
            : title;
        gtk_label_set_markup(_statusText, $"<span size=\"large\" weight=\"bold\">{Escape(titleText)}</span>");
        gtk_label_set_markup(_statusDetail, $"<span foreground=\"#696969\">{Escape(detail)}</span>");

        gtk_widget_set_visible(_start, _serviceOff);
        // 처음 show_all로 안쪽 위젯까지 보이게 해 두고 여기서는 묶음만 켜고 끈다 ([업데이트]는 no_show_all이라 따로)
        gtk_widget_set_visible(_runningPanel, !_serviceOff);

        if (status is not null)
        {
            // 사용자가 입력 중인 주소는 덮어쓰지 않는다
            if (!_serverEdited && !gtk_widget_has_focus(_serverUrl) && GetEntryText(_serverUrl) != status.ServerUrl)
            {
                _settingServerText = true;
                gtk_entry_set_text(_serverUrl, status.ServerUrl);
                _settingServerText = false;
            }
            if (status.Status == ConnectionStatus.Connected)
                _serverEdited = false;

            var serverVersion = status.ServerVersion is null ? "" : $" · 서버 {status.ServerVersion}";
            gtk_label_set_markup(_info, $"<span foreground=\"#696969\">{Escape($"PC {status.MachineName} · 에이전트 {status.AgentVersion}{serverVersion}")}</span>");
            gtk_button_set_label(_update, status.Updating ? "업데이트 중…" : $"업데이트 ({status.ServerVersion})");
            gtk_widget_set_visible(_update, status.UpdateAvailable || status.Updating);
        }

        // 꺼진 상태는 상세 문구로 이미 안내하므로 오류는 감추고, 그 외 오류·업데이트 실패 이유만 표시
        if (_serviceOff)
            SetError("");
        else if (error is not null)
            SetError(error);
        else if (status is { Updating: false, UpdateNote: { } failed })
            SetError(failed);

        UpdateButtons();
    }

    private void UpdateButtons()
    {
        var available = !_serviceOff && _status is not null && !_status.Updating && _busyCommand is null;
        gtk_widget_set_sensitive(_serverUrl, available);
        gtk_widget_set_sensitive(_connect, available);
        gtk_widget_set_sensitive(_disconnect, available && _status!.Status is ConnectionStatus.Connected or ConnectionStatus.Connecting);
        gtk_widget_set_sensitive(_update, available && _status!.UpdateAvailable);
        gtk_widget_set_sensitive(_stop, available);
        gtk_widget_set_sensitive(_dashboard, _status is { ServerUrl.Length: > 0 });
        gtk_widget_set_sensitive(_start, _serviceOff && _busyCommand is null);
    }

    private static string Escape(string text) =>
        text.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
}
