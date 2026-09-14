namespace PcManager.Agent.Install;

/// <summary>설치/제거 진행 로그 창</summary>
internal sealed class SetupForm : Form
{
    private readonly TextBox _log = new()
    {
        Multiline = true,
        ReadOnly = true,
        Dock = DockStyle.Fill,
        ScrollBars = ScrollBars.Vertical,
        BorderStyle = BorderStyle.None,
        BackColor = Color.White,
        Font = new Font("Malgun Gothic", 9f),
        TabStop = false,
    };

    private readonly Button _close = new()
    {
        Text = "닫기",
        AutoSize = true,
        MinimumSize = new Size(100, 32),
        Anchor = AnchorStyles.Right,
        Enabled = false,
        Visible = false,
    };

    private System.Windows.Forms.Timer? _autoClose;

    public SetupForm(string title)
    {
        Text = title;
        Icon = Launcher.TrayIcons.Connected;
        Font = new Font("Malgun Gothic", 9f);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(460, 300);
        Padding = new Padding(12);
        BackColor = Color.White;

        var footer = new Panel { Dock = DockStyle.Bottom, Height = 44 };
        footer.Controls.Add(_close);
        _close.Location = new Point(footer.Width - _close.Width - 4, 6);
        _close.Anchor = AnchorStyles.Right | AnchorStyles.Top;
        _close.Click += (_, _) => Close();

        Controls.Add(_log);
        Controls.Add(footer);
    }

    public void Log(string message)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => Log(message));
            return;
        }
        _log.AppendText((_log.TextLength > 0 ? Environment.NewLine : "") + message);
    }

    public void Finish(bool success, bool autoClose)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => Finish(success, autoClose));
            return;
        }

        if (autoClose && success)
        {
            _autoClose = new System.Windows.Forms.Timer { Interval = 2500 };
            _autoClose.Tick += (_, _) =>
            {
                _autoClose.Stop();
                Close();
            };
            _autoClose.Start();
        }

        _close.Enabled = true;
        _close.Visible = true;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
            _autoClose?.Dispose();
        base.Dispose(disposing);
    }
}
