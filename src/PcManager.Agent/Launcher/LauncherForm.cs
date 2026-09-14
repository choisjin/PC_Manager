namespace PcManager.Agent.Launcher;

/// <summary>컴팩트 런처 창: 연결 상태, 서버 주소, 연결/끊기, 업데이트, 에이전트 시작/종료</summary>
internal sealed class LauncherForm : Form
{
    private readonly Label _statusDot = new() { AutoSize = true, Font = new Font("Segoe UI", 16f), Margin = new Padding(0, 0, 6, 0) };
    private readonly Label _statusText = new() { AutoSize = true, Font = new Font("Malgun Gothic", 12f, FontStyle.Bold), Margin = new Padding(0, 4, 0, 0) };
    private readonly Label _statusDetail = new() { AutoSize = true, ForeColor = Color.DimGray, MaximumSize = new Size(340, 0) };

    // 서비스 실행 중일 때 보이는 영역
    private readonly TableLayoutPanel _runningPanel = new() { AutoSize = true, ColumnCount = 1, Margin = new Padding(0), MinimumSize = new Size(340, 0) };
    private readonly TextBox _serverUrl = new() { Dock = DockStyle.Fill, PlaceholderText = "예: 192.168.0.10:5063" };
    private readonly Button _connect = new() { Text = "연결", AutoSize = true, MinimumSize = new Size(88, 30) };
    private readonly Button _disconnect = new() { Text = "끊기", AutoSize = true, MinimumSize = new Size(88, 30) };
    private readonly Label _info = new() { AutoSize = true, ForeColor = Color.DimGray };
    private readonly Button _update = new() { AutoSize = true, MinimumSize = new Size(88, 30), Visible = false };
    private readonly LinkLabel _dashboard = new() { Text = "대시보드 열기", AutoSize = true };
    private readonly LinkLabel _stop = new() { Text = "에이전트 종료", AutoSize = true, LinkColor = Color.Firebrick };

    // 서비스가 꺼져 있을 때 보이는 버튼
    private readonly Button _start = new() { Text = "에이전트 시작", AutoSize = true, MinimumSize = new Size(120, 32), Visible = false };

    private readonly Label _error = new() { AutoSize = true, ForeColor = Color.Firebrick, MaximumSize = new Size(340, 0) };

    private LocalStatus? _status;
    private bool _serviceOff = true;
    private bool _serverEdited;
    private bool _settingServerText;
    private string? _busyCommand;

    public event Action<string>? ConnectRequested;
    public event Action? DisconnectRequested;
    public event Action? UpdateRequested;
    public event Action? DashboardRequested;
    public event Action? StopRequested;
    public event Action? StartRequested;

    public LauncherForm()
    {
        Text = "PC Manager 에이전트";
        Icon = TrayIcons.Connected;
        Font = new Font("Malgun Gothic", 9f);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(16);
        BackColor = Color.White;

        var statusRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0) };
        statusRow.Controls.AddRange([_statusDot, _statusText]);

        var buttons = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0, 6, 0, 0) };
        buttons.Controls.AddRange([_connect, _disconnect]);

        var bottomRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0, 8, 0, 0) };
        bottomRow.Controls.AddRange([_update, _dashboard, _stop]);
        _dashboard.Margin = new Padding(8, 8, 0, 0);
        _stop.Margin = new Padding(16, 8, 0, 0);

        _runningPanel.Controls.Add(new Label { Text = "서버 주소", AutoSize = true, Margin = new Padding(0, 14, 0, 4) });
        _runningPanel.Controls.Add(_serverUrl);
        _runningPanel.Controls.Add(buttons);
        _runningPanel.Controls.Add(new Label { AutoSize = false, Height = 1, Dock = DockStyle.Fill, BackColor = Color.Gainsboro, Margin = new Padding(0, 12, 0, 8) });
        _runningPanel.Controls.Add(_info);
        _runningPanel.Controls.Add(bottomRow);

        _start.Margin = new Padding(0, 14, 0, 0);

        var layout = new TableLayoutPanel
        {
            AutoSize = true,
            ColumnCount = 1,
            Dock = DockStyle.Fill,
            MinimumSize = new Size(340, 0),
        };
        layout.Controls.Add(statusRow);
        layout.Controls.Add(_statusDetail);
        layout.Controls.Add(_start);
        layout.Controls.Add(_runningPanel);
        layout.Controls.Add(_error);
        Controls.Add(layout);

        AcceptButton = _connect;
        _serverUrl.TextChanged += (_, _) =>
        {
            if (!_settingServerText)
                _serverEdited = true;
        };
        _connect.Click += (_, _) => Fire(() => ConnectRequested?.Invoke(_serverUrl.Text));
        _disconnect.Click += (_, _) => Fire(() => DisconnectRequested?.Invoke());
        _update.Click += (_, _) => Fire(() => UpdateRequested?.Invoke());
        _start.Click += (_, _) => Fire(() => StartRequested?.Invoke());
        _stop.LinkClicked += (_, _) => Fire(() => StopRequested?.Invoke());
        _dashboard.LinkClicked += (_, _) => DashboardRequested?.Invoke();

        ApplyStatus(null, null);
    }

    private void Fire(Action action)
    {
        _error.Text = "";
        action();
    }

    public void ShowAndActivate()
    {
        if (!Visible)
        {
            // 작업 표시줄 알림 영역 근처(오른쪽 아래)에 띄운다
            var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 720);
            Location = new Point(area.Right - Width - 12, area.Bottom - Height - 12);
            Show();
        }
        if (WindowState == FormWindowState.Minimized)
            WindowState = FormWindowState.Normal;
        Activate();
    }

    public void SetBusy(string? command)
    {
        _busyCommand = command;
        _connect.Text = command == LocalControl.ConnectCommand ? "연결 중…" : "연결";
        _start.Text = command == "start" ? "시작 중…" : "에이전트 시작";
        UpdateButtons();
    }

    public void ShowError(string message) => _error.Text = message;

    public void ApplyStatus(LocalStatus? status, string? error)
    {
        _status = status;
        _serviceOff = status is null;
        var (color, title, detail) = status?.Status switch
        {
            ConnectionStatus.Connected => (TrayIcons.ConnectedColor, "연결됨", status.ServerUrl),
            ConnectionStatus.Connecting => (TrayIcons.ConnectingColor, "연결 중…", status.LastError is null ? status.ServerUrl : $"재시도 중: {status.LastError}"),
            ConnectionStatus.Disconnected => (TrayIcons.DisconnectedColor, "연결 끊김", "서버 주소를 확인하고 [연결]을 누르세요"),
            ConnectionStatus.NotConfigured => (TrayIcons.DisconnectedColor, "서버에 연결되지 않음", "서버 주소를 입력하고 [연결]을 누르세요"),
            _ => (TrayIcons.ErrorColor, "에이전트 꺼짐", "에이전트가 중지되었습니다. [에이전트 시작]을 누르세요."),
        };
        _statusDot.Text = "●";
        _statusDot.ForeColor = color;
        _statusText.Text = status?.Updating == true ? "업데이트 중…" : title;
        _statusDetail.Text = detail;

        _start.Visible = _serviceOff;
        _runningPanel.Visible = !_serviceOff;

        if (status is not null)
        {
            // 사용자가 입력 중인 주소는 덮어쓰지 않는다
            if (!_serverEdited && !_serverUrl.Focused && _serverUrl.Text != status.ServerUrl)
            {
                _settingServerText = true;
                _serverUrl.Text = status.ServerUrl;
                _settingServerText = false;
            }
            if (status.Status == ConnectionStatus.Connected)
                _serverEdited = false;

            var serverVersion = status.ServerVersion is null ? "" : $" · 서버 {status.ServerVersion}";
            _info.Text = $"PC {status.MachineName} · 에이전트 {status.AgentVersion}{serverVersion}";
            _update.Text = status.Updating ? "업데이트 중…" : $"업데이트 ({status.ServerVersion})";
            _update.Visible = status.UpdateAvailable || status.Updating;
        }

        // 꺼진 상태는 상세 문구로 이미 안내하므로 중복 오류는 감추고, 그 외 오류만 표시
        _error.Text = _serviceOff ? "" : error ?? _error.Text;

        UpdateButtons();
    }

    private void UpdateButtons()
    {
        var available = !_serviceOff && _status is not null && !_status.Updating && _busyCommand is null;
        _serverUrl.Enabled = available;
        _connect.Enabled = available;
        _disconnect.Enabled = available && _status!.Status is ConnectionStatus.Connected or ConnectionStatus.Connecting;
        _update.Enabled = available && _status!.UpdateAvailable;
        _stop.Enabled = available;
        _dashboard.Enabled = _status is { ServerUrl.Length: > 0 };
        _start.Enabled = _serviceOff && _busyCommand is null;
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // 닫기(X)는 트레이로 숨기기 (에이전트는 계속 실행). 완전히 끄려면 [에이전트 종료]
        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        base.OnFormClosing(e);
    }
}
