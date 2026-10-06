namespace PcManager.ServerLauncher;

/// <summary>서버 추가 / 설정 변경 창</summary>
internal sealed class InstanceDialog : Form
{
    private readonly TextBox _name = new() { Width = 260 };
    private readonly NumericUpDown _port = new() { Minimum = 1, Maximum = 65535, Width = 100 };
    private readonly TextBox _data = new() { Width = 340 };
    private readonly CheckBox _autoStart = new() { Text = "런처를 켤 때 자동 시작", AutoSize = true, Checked = true };
    private readonly CheckBox _firewall = new() { Text = "방화벽에서 이 포트 열기 (관리자 승인)", AutoSize = true, Checked = true };
    private readonly Label _error = new() { AutoSize = true, ForeColor = Color.Firebrick, MaximumSize = new Size(440, 0) };
    private readonly Func<InstanceConfig, string?> _validate;
    private readonly bool _isNew;

    /// <param name="existing">null이면 새로 만들기</param>
    /// <param name="validate">입력 검사. 오류 메시지 또는 null</param>
    public InstanceDialog(InstanceConfig? existing, int suggestedPort, Func<InstanceConfig, string?> validate)
    {
        _validate = validate;
        _isNew = existing is null;

        Text = _isNew ? "서버 추가" : $"서버 설정 — {existing!.Name}";
        Font = new Font("Malgun Gothic", 9f);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(16);
        BackColor = Color.White;

        _name.Text = existing?.Name ?? "";
        _name.ReadOnly = !_isNew;
        _port.Value = existing?.Port ?? suggestedPort;
        _data.Text = existing?.DataDirectory ?? "";
        _data.PlaceholderText = "비우면 instances\\이름\\data";
        _autoStart.Checked = existing?.AutoStart ?? true;
        _firewall.Checked = _isNew;

        var browse = new Button { Text = "찾아보기…", AutoSize = true };
        browse.Click += (_, _) =>
        {
            using var dialog = new FolderBrowserDialog { Description = "데이터 폴더 (DB·로그·결과 파일)", UseDescriptionForTitle = true };
            if (dialog.ShowDialog(this) == DialogResult.OK)
                _data.Text = dialog.SelectedPath;
        };

        var grid = new TableLayoutPanel { AutoSize = true, ColumnCount = 2 };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        void Row(string label, Control control)
        {
            grid.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 8, 12, 0) });
            grid.Controls.Add(control);
        }
        Row("이름", _name);
        Row("포트", _port);
        var dataRow = new FlowLayoutPanel { AutoSize = true, WrapContents = false, Margin = new Padding(0) };
        dataRow.Controls.Add(_data);
        dataRow.Controls.Add(browse);
        Row("데이터 폴더", dataRow);
        grid.Controls.Add(new Label());
        var checks = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.TopDown, Margin = new Padding(0, 6, 0, 0) };
        checks.Controls.Add(_autoStart);
        checks.Controls.Add(_firewall);
        grid.Controls.Add(checks);

        var hint = new Label
        {
            AutoSize = true,
            ForeColor = Color.DimGray,
            MaximumSize = new Size(440, 0),
            Margin = new Padding(0, 10, 0, 0),
            Text = _isNew
                ? "이름은 영문·숫자·-_ 만 쓸 수 있고 나중에 바꿀 수 없습니다. 이미 쓰던 데이터 폴더를 지정하면 그 데이터를 그대로 씁니다."
                : "포트·데이터 폴더를 바꾸면 실행 중인 서버는 다시 시작됩니다. 에이전트들의 서버 주소도 바꿔야 합니다.",
        };

        var ok = new Button { Text = _isNew ? "추가" : "저장", AutoSize = true, DialogResult = DialogResult.None };
        var cancel = new Button { Text = "취소", AutoSize = true, DialogResult = DialogResult.Cancel };
        ok.Click += (_, _) => Submit();
        var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, Margin = new Padding(0, 12, 0, 0) };
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(ok);
        AcceptButton = ok;
        CancelButton = cancel;

        var layout = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Dock = DockStyle.Fill };
        layout.Controls.Add(grid);
        layout.Controls.Add(hint);
        layout.Controls.Add(_error);
        layout.Controls.Add(buttons);
        Controls.Add(layout);
    }

    public InstanceConfig Result { get; private set; } = new();
    public bool OpenFirewall => _firewall.Checked;

    private void Submit()
    {
        var candidate = new InstanceConfig
        {
            Name = _name.Text.Trim(),
            Port = (int)_port.Value,
            DataDirectory = string.IsNullOrWhiteSpace(_data.Text) ? null : _data.Text.Trim(),
            AutoStart = _autoStart.Checked,
        };
        if (_validate(candidate) is { } error)
        {
            _error.Text = error;
            return;
        }
        Result = candidate;
        DialogResult = DialogResult.OK;
    }
}
