namespace PcManager.ServerLauncher;

/// <summary>업데이트할 서버 고르기. 작업 중인 서버는 빼 두면 지금 버전으로 계속 실행된다</summary>
internal sealed class UpdateDialog : Form
{
    private readonly CheckedListBox _list = new() { CheckOnClick = true, Width = 460, Height = 160, IntegralHeight = false };
    private readonly CheckBox _agents = new() { Text = "에이전트도 업데이트 (실행 중인 명령이 없는 PC부터, 나중에 켜지는 PC도)", AutoSize = true, Checked = true };
    private readonly List<ServerInstance> _instances;

    /// <param name="candidates">target 버전이 아닌 인스턴스들</param>
    public UpdateDialog(Version target, Version? installed, IReadOnlyList<ServerInstance> candidates)
    {
        _instances = [.. candidates];

        Text = "업데이트";
        Font = new Font("Malgun Gothic", 9f);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(16);
        BackColor = Color.White;

        var title = new Label
        {
            AutoSize = true,
            Font = new Font(Font, FontStyle.Bold),
            Text = installed is not null && installed >= target
                ? $"v{target.ToString(3)}(으)로 옮길 서버를 고르세요."
                : $"v{target.ToString(3)}을(를) {(installed is null ? "설치" : "받아 설치")}하고, 옮길 서버를 고르세요.",
        };
        foreach (var instance in _instances)
        {
            var version = (instance.RunningBuild?.Version ?? ServerPackage.FindBuild(instance.Config.ServerVersion)?.Version)?.ToString(3);
            var state = instance.IsActive ? "실행 중 — 잠시 중지 후 다시 시작" : "중지됨";
            _list.Items.Add($"{instance.Config.Name} (포트 {instance.Config.Port})   v{version ?? "?"}   {state}", isChecked: true);
        }
        var hint = new Label
        {
            AutoSize = true,
            ForeColor = Color.DimGray,
            MaximumSize = new Size(460, 0),
            Margin = new Padding(0, 8, 0, 0),
            Text = "작업 중인 서버는 체크를 빼세요. 지금 버전으로 계속 실행되고, 나중에 [일괄 업데이트]로 따로 올릴 수 있습니다. " +
                "에이전트 업데이트는 그 서버에 접속한 구버전 에이전트만 대상입니다.",
        };

        var ok = new Button { Text = "업데이트", AutoSize = true, DialogResult = DialogResult.OK };
        var cancel = new Button { Text = "취소", AutoSize = true, DialogResult = DialogResult.Cancel };
        var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, Margin = new Padding(0, 12, 0, 0) };
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(ok);
        AcceptButton = ok;
        CancelButton = cancel;

        var layout = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Dock = DockStyle.Fill };
        layout.Controls.Add(title);
        layout.Controls.Add(new Label { Height = 6 });
        layout.Controls.Add(_list);
        layout.Controls.Add(_agents);
        layout.Controls.Add(hint);
        layout.Controls.Add(buttons);
        Controls.Add(layout);
    }

    public IReadOnlyList<ServerInstance> Selected =>
        _list.CheckedIndices.Cast<int>().Select(i => _instances[i]).ToList();

    public bool UpdateAgents => _agents.Checked;
}
