using System.Net;

namespace PcManager.ServerLauncher;

/// <summary>
/// HTTPS 인증서에 더 넣을 주소: 이 PC에 없는 주소로 대시보드를 여는 경우 (공유기 포트 포워딩의 바깥 주소, DNS 이름 등).
/// 이 PC의 IP·이름은 알아서 들어가므로 적지 않아도 된다
/// </summary>
internal sealed class CertificateHostsDialog : Form
{
    private readonly TextBox _hosts = new() { Width = 420 };
    private readonly Label _error = new() { AutoSize = true, ForeColor = Color.Firebrick, MaximumSize = new Size(440, 0) };

    public CertificateHostsDialog(IReadOnlyList<string> current)
    {
        Text = "HTTPS 인증서 추가 주소";
        Font = new Font("Malgun Gothic", 9f);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterParent;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(16);
        BackColor = Color.White;

        _hosts.Text = string.Join(", ", current);
        _hosts.PlaceholderText = "예: 10.176.144.70, pcmanager.mycompany.local";

        var hint = new Label
        {
            AutoSize = true,
            ForeColor = Color.DimGray,
            MaximumSize = new Size(440, 0),
            Margin = new Padding(0, 10, 0, 0),
            Text = "이 PC에 없는 주소로 대시보드를 여는 경우에 적습니다 (공유기 포트 포워딩의 바깥 주소, DNS 이름 등). "
                + "쉼표로 여러 개. 이 PC의 IP·이름은 알아서 들어갑니다. 바꾸면 인증서를 새로 만들고 HTTPS 서버를 다시 시작합니다.",
        };

        var ok = new Button { Text = "저장", AutoSize = true, DialogResult = DialogResult.None };
        var cancel = new Button { Text = "취소", AutoSize = true, DialogResult = DialogResult.Cancel };
        ok.Click += (_, _) => Submit();
        var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, Margin = new Padding(0, 12, 0, 0) };
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(ok);
        AcceptButton = ok;
        CancelButton = cancel;

        var layout = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Dock = DockStyle.Fill };
        layout.Controls.Add(new Label { Text = "추가 주소", AutoSize = true, Margin = new Padding(0, 0, 0, 4) });
        layout.Controls.Add(_hosts);
        layout.Controls.Add(hint);
        layout.Controls.Add(_error);
        layout.Controls.Add(buttons);
        Controls.Add(layout);
    }

    public List<string> Result { get; private set; } = [];

    private void Submit()
    {
        var hosts = new List<string>();
        foreach (var raw in _hosts.Text.Split([',', ';', ' '], StringSplitOptions.RemoveEmptyEntries))
        {
            // http://주소:포트 처럼 붙여 넣어도 호스트만 쓴다
            var host = Uri.TryCreate(raw, UriKind.Absolute, out var uri) && uri.Host.Length > 0 ? uri.Host : raw.Split(':')[0];
            if (!IPAddress.TryParse(host, out _) && Uri.CheckHostName(host) != UriHostNameType.Dns)
            {
                _error.Text = $"주소가 올바르지 않습니다: {raw}";
                return;
            }
            if (!hosts.Contains(host, StringComparer.OrdinalIgnoreCase))
                hosts.Add(host);
        }
        Result = hosts;
        DialogResult = DialogResult.OK;
    }
}
