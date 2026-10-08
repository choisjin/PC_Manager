using System.Diagnostics;

namespace PcManager.Agent.Launcher;

/// <summary>트레이 아이콘과 런처 창, 서비스 상태 주기 조회를 관리한다.</summary>
internal sealed class LauncherContext : ApplicationContext
{
    private static readonly TimeSpan StatusTimeout = TimeSpan.FromSeconds(3);

    private readonly NotifyIcon _tray;
    private readonly LauncherForm _form;
    private readonly System.Windows.Forms.Timer _timer;
    private readonly System.Windows.Forms.Timer _displayTimer;
    private readonly RegisteredWaitHandle _showWait;
    private bool _refreshing;
    private LocalStatus? _lastStatus;

    public LauncherContext(EventWaitHandle showEvent, bool showWindow)
    {
        _form = new LauncherForm();
        _form.ConnectRequested += url => _ = SendAsync(new LocalRequest(LocalControl.ConnectCommand, url), TimeSpan.FromSeconds(20));
        _form.DisconnectRequested += () => _ = SendAsync(new LocalRequest(LocalControl.DisconnectCommand), StatusTimeout);
        _form.UpdateRequested += () => _ = SendAsync(new LocalRequest(LocalControl.UpdateCommand), TimeSpan.FromMinutes(3));
        _form.DashboardRequested += OpenDashboard;
        _form.StopRequested += () => _ = StopAgentAsync();
        _form.StartRequested += StartAgent;
        // 창 핸들을 미리 만들어 다른 스레드에서 BeginInvoke할 수 있게 한다
        _ = _form.Handle;

        var menu = new ContextMenuStrip();
        menu.Items.Add("열기", null, (_, _) => ShowForm());
        menu.Items.Add("대시보드 열기", null, (_, _) => OpenDashboard());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("에이전트 종료", null, (_, _) => _ = StopAgentAsync());

        _tray = new NotifyIcon
        {
            Icon = TrayIcons.Unknown,
            Text = "PC Manager 에이전트",
            ContextMenuStrip = menu,
            Visible = true,
        };
        _tray.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left)
                ShowForm();
        };

        _showWait = ThreadPool.RegisterWaitForSingleObject(
            showEvent, (_, _) => _form.BeginInvoke(ShowForm), null, Timeout.Infinite, executeOnlyOnce: false);

        _timer = new System.Windows.Forms.Timer { Interval = 2000 };
        _timer.Tick += async (_, _) => await RefreshAsync();
        _timer.Start();
        // 가상 모니터가 물리 모니터와 함께 켜져 있으면(덮개를 다시 연 노트북 등) 서비스에 끄기를 요청한다 — 멀티 모니터로 쓰지 않게
        _displayTimer = new System.Windows.Forms.Timer { Interval = 10_000 };
        _displayTimer.Tick += async (_, _) => await CheckVirtualDisplayAsync();
        _displayTimer.Start();
        _ = RefreshAsync(firstRun: showWindow);
    }

    private async Task CheckVirtualDisplayAsync()
    {
        try
        {
            if (!Remote.VirtualDisplay.NeedsRelease())
                return;
            await LocalControlClient.SendAsync(new LocalRequest(LocalControl.ReleaseVirtualDisplayCommand), StatusTimeout);
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or TimeoutException or UnauthorizedAccessException)
        {
            // 다음 확인 때 다시
        }
    }

    private async Task RefreshAsync(bool firstRun = false)
    {
        if (_refreshing)
            return;
        _refreshing = true;
        try
        {
            var response = await LocalControlClient.SendAsync(new LocalRequest(LocalControl.StatusCommand), StatusTimeout);
            Apply(response);

            // 처음 실행했거나 서버 주소가 아직 없으면 창을 띄워 입력을 받는다
            if (firstRun || response.Status?.Status == ConnectionStatus.NotConfigured && _lastStatus is null)
                ShowForm();
            _lastStatus = response.Status;
        }
        finally
        {
            _refreshing = false;
        }
    }

    private async Task SendAsync(LocalRequest request, TimeSpan timeout)
    {
        _form.SetBusy(request.Command);
        var response = await LocalControlClient.SendAsync(request, timeout);
        _form.SetBusy(null);
        Apply(response);
        if (!response.Ok && response.Error is not null)
            _form.ShowError(response.Error);
    }

    /// <summary>에이전트 서비스를 완전히 종료하고 런처도 닫는다.</summary>
    private async Task StopAgentAsync()
    {
        _form.SetBusy(LocalControl.StopCommand);
        var response = await LocalControlClient.SendAsync(new LocalRequest(LocalControl.StopCommand), StatusTimeout);
        _form.SetBusy(null);

        // Ok(서비스가 곧 멈춤) 또는 이미 꺼져 있으면(Status null) 런처 종료
        if (response.Ok || response.Status is null)
            ExitThread();
        else if (response.Error is not null)
            _form.ShowError(response.Error);
    }

    /// <summary>멈춘 에이전트 서비스를 다시 시작한다 (별도 프로세스가 관리자 승격).</summary>
    private void StartAgent()
    {
        _form.SetBusy("start");
        try
        {
            Process.Start(new ProcessStartInfo(Environment.ProcessPath!)
            {
                Arguments = "--start-service",
                UseShellExecute = false,
            });
            // 서비스가 뜨면 다음 상태 조회에서 자동으로 반영된다
        }
        catch (Exception ex)
        {
            _form.ShowError($"시작 실패: {ex.Message}");
        }
        _form.SetBusy(null);
    }

    private void Apply(LocalResponse response)
    {
        var status = response.Status;
        _form.ApplyStatus(status, response.Ok ? null : response.Error);

        var (icon, text) = status?.Status switch
        {
            ConnectionStatus.Connected => (TrayIcons.Connected, "연결됨"),
            ConnectionStatus.Connecting => (TrayIcons.Connecting, "연결 중"),
            ConnectionStatus.Disconnected => (TrayIcons.Disconnected, "연결 끊김"),
            ConnectionStatus.NotConfigured => (TrayIcons.Disconnected, "서버 주소 필요"),
            _ => (TrayIcons.Unknown, "에이전트 꺼짐"),
        };
        if (status?.Updating == true)
            text = "업데이트 중";
        else if (status?.UpdateAvailable == true)
            text += " · 업데이트 있음";

        _tray.Icon = icon;
        // 알림 영역 툴팁은 63자 제한
        var tooltip = $"PC Manager 에이전트: {text}";
        _tray.Text = tooltip.Length > 63 ? tooltip[..63] : tooltip;
    }

    private void ShowForm()
    {
        _form.ShowAndActivate();
    }

    private void OpenDashboard()
    {
        // 원격조작(키보드 잠금·저지연 화면)은 HTTPS에서만 되므로 서버가 알려준 HTTPS 주소를 우선 쓴다.
        // 이 PC의 에이전트가 서버 인증서를 신뢰 저장소에 넣어 두므로 경고 없이 열린다
        var url = _lastStatus?.DashboardUrl ?? _lastStatus?.ServerUrl;
        // 이 PC가 연 대시보드임을 알려 Remote 화면에서 자기 PC를 숨기게 한다 (자기 화면을 원격하면 무한히 겹친다)
        if (!string.IsNullOrWhiteSpace(url) && _lastStatus?.MachineName is { Length: > 0 } self)
            url = $"{url.TrimEnd('/')}/?pc={Uri.EscapeDataString(self)}";
        if (string.IsNullOrWhiteSpace(url))
        {
            ShowForm();
            return;
        }
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _showWait.Unregister(null);
            _timer.Dispose();
            _displayTimer.Dispose();
            _tray.Visible = false;
            _tray.Dispose();
            _form.Dispose();
        }
        base.Dispose(disposing);
    }
}
