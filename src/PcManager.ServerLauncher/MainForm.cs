using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Text.RegularExpressions;

namespace PcManager.ServerLauncher;

/// <summary>서버 목록과 실행·중지·추가·삭제·일괄 업데이트. 실행 중인 서버가 있으면 창을 닫아도 트레이에 남는다</summary>
internal sealed partial class MainForm : Form
{
    private const int DefaultPort = 5063;

    private readonly JobObject _job = new();
    private readonly LauncherConfig _config;
    private readonly List<ServerInstance> _instances;
    private readonly bool _startMinimized;

    private readonly ListView _list = new()
    {
        View = View.Details,
        FullRowSelect = true,
        MultiSelect = false,
        HideSelection = false,
        Dock = DockStyle.Fill,
        BorderStyle = BorderStyle.FixedSingle,
    };
    private readonly Button _add = new() { Text = "서버 추가" };
    private readonly Button _start = new() { Text = "시작" };
    private readonly Button _stop = new() { Text = "중지" };
    private readonly Button _restart = new() { Text = "재시작" };
    private readonly Button _edit = new() { Text = "설정" };
    private readonly Button _remove = new() { Text = "삭제" };
    private readonly Button _open = new() { Text = "대시보드 열기" };
    private readonly Button _copy = new() { Text = "주소 복사" };
    private readonly Button _folder = new() { Text = "데이터 폴더" };
    private readonly Button _logs = new() { Text = "로그" };
    private readonly Button _startAll = new() { Text = "전체 시작" };
    private readonly Button _stopAll = new() { Text = "전체 중지" };
    private readonly Button _update = new() { Text = "일괄 업데이트" };
    private readonly Button _updateZip = new() { Text = "zip으로 업데이트…" };
    private readonly Button _trust = new() { Text = "HTTPS 인증서 신뢰(이 PC)" };
    private readonly Label _version = new() { AutoSize = true, Margin = new Padding(0, 8, 12, 0) };
    private readonly Label _status = new() { AutoSize = true, ForeColor = Color.DimGray, Margin = new Padding(0, 8, 0, 0) };
    private readonly ProgressBar _progress = new() { Width = 160, Visible = false, Margin = new Padding(8, 6, 0, 0) };
    private readonly CheckBox _autorun = new() { Text = "Windows 로그인 시 런처 실행", AutoSize = true, Margin = new Padding(0, 8, 0, 0) };
    private readonly NotifyIcon _tray = new() { Text = "PC Manager 서버 런처" };
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 1500 };

    private Version? _latest;
    private bool _busy;
    private bool _refreshing;
    private bool _exiting;
    private bool _trayHintShown;
    private bool _certificateTrusted;

    public MainForm(bool startMinimized)
    {
        _startMinimized = startMinimized;
        _config = LauncherStore.Load();
        _instances = _config.Instances.Select(c => new ServerInstance(c, _job)).ToList();

        Text = "PC Manager 서버 런처";
        Font = new Font("Malgun Gothic", 9f);
        Size = new Size(980, 460);
        MinimumSize = new Size(760, 320);
        StartPosition = FormStartPosition.CenterScreen;
        Padding = new Padding(12);
        BackColor = Color.White;
        Icon = AppIcon.Create(Color.FromArgb(140, 146, 156));

        _list.Columns.Add("상태", 90);
        _list.Columns.Add("이름", 120);
        _list.Columns.Add("포트", 60);
        _list.Columns.Add("에이전트 접속 주소", 180);
        _list.Columns.Add("대시보드 HTTPS", 180);
        _list.Columns.Add("데이터 폴더", 260);
        _list.Columns.Add("자동 시작", 70);
        _list.Columns.Add("메시지", 300);
        _list.SelectedIndexChanged += (_, _) => UpdateButtons();
        _list.DoubleClick += (_, _) => OpenDashboard();

        var top = Row();
        foreach (var b in new[] { _add, _start, _stop, _restart, _edit, _remove })
            top.Controls.Add(Styled(b));
        top.Controls.Add(new Label { Width = 16 });
        foreach (var b in new[] { _open, _copy, _folder, _logs })
            top.Controls.Add(Styled(b));

        var bottom = Row();
        bottom.Controls.Add(_version);
        foreach (var b in new[] { _update, _updateZip })
            bottom.Controls.Add(Styled(b));
        bottom.Controls.Add(new Label { Width = 16 });
        foreach (var b in new[] { _startAll, _stopAll })
            bottom.Controls.Add(Styled(b));
        bottom.Controls.Add(new Label { Width = 16 });
        bottom.Controls.Add(Styled(_trust));
        bottom.Controls.Add(_progress);

        var footer = Row();
        footer.Controls.Add(_autorun);
        footer.Controls.Add(new Label { Width = 16 });
        footer.Controls.Add(_status);

        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4 };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(top);
        layout.Controls.Add(_list);
        layout.Controls.Add(bottom);
        layout.Controls.Add(footer);
        Controls.Add(layout);

        _add.Click += (_, _) => AddInstance();
        _start.Click += (_, _) => { if (Selected is { } i) StartInstance(i); };
        _stop.Click += async (_, _) => { if (Selected is { } i) await RunBusy($"{i.Config.Name} 중지 중…", i.StopAsync); };
        _restart.Click += async (_, _) => { if (Selected is { } i) await RunBusy($"{i.Config.Name} 재시작 중…", () => RestartAsync(i)); };
        _edit.Click += async (_, _) => await EditInstanceAsync();
        _remove.Click += async (_, _) => await RemoveInstanceAsync();
        _open.Click += (_, _) => OpenDashboard();
        _copy.Click += (_, _) => { if (Selected is { } i) { Clipboard.SetText(AgentAddress(i)); SetStatus("복사됨: " + AgentAddress(i)); } };
        _folder.Click += (_, _) => { if (Selected is { } i) OpenPath(i.Config.ResolvedDataDirectory); };
        _logs.Click += (_, _) => { if (Selected is { } i) OpenPath(LauncherPaths.LogFile(i.Config.Name)); };
        _startAll.Click += (_, _) => { foreach (var i in _instances.Where(i => !i.IsActive)) StartInstance(i); };
        _stopAll.Click += async (_, _) => await RunBusy("전체 중지 중…", StopAllAsync);
        _update.Click += async (_, _) => await UpdateFromGitHubAsync();
        _updateZip.Click += async (_, _) => await UpdateFromZipAsync();
        _trust.Click += (_, _) => TrustCertificate();
        _autorun.Checked = Autorun.IsEnabled;
        _autorun.CheckedChanged += (_, _) => Autorun.Set(_autorun.Checked);

        var menu = new ContextMenuStrip();
        menu.Items.Add("열기", null, (_, _) => ShowFromTray());
        menu.Items.Add("전체 시작", null, (_, _) => _startAll.PerformClick());
        menu.Items.Add("전체 중지", null, (_, _) => _stopAll.PerformClick());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("종료", null, async (_, _) => await ExitAsync());
        _tray.ContextMenuStrip = menu;
        _tray.Icon = Icon;
        _tray.Visible = true;
        _tray.DoubleClick += (_, _) => ShowFromTray();

        _timer.Tick += async (_, _) => await RefreshAsync();
        RefreshList();
    }

    private ServerInstance? Selected =>
        _list.SelectedItems.Count == 1 ? _list.SelectedItems[0].Tag as ServerInstance : null;

    protected override void SetVisibleCore(bool value)
    {
        // 로그인 자동 실행(--minimized)이면 창 없이 트레이로 시작
        if (_startMinimized && !IsHandleCreated)
        {
            CreateHandle();
            value = false;
            OnShownOnce();
        }
        base.SetVisibleCore(value);
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        OnShownOnce();
    }

    private bool _initialized;

    private void OnShownOnce()
    {
        if (_initialized)
            return;
        _initialized = true;
        _timer.Start();

        EnsureCertificate(askTrust: !_startMinimized);
        if (ServerPackage.InstalledVersion() is null)
            SetStatus("서버 파일이 없습니다. [일괄 업데이트]로 최신 서버를 받으세요.");
        else
            foreach (var instance in _instances.Where(i => i.Config.AutoStart))
                StartInstance(instance);
        _ = CheckLatestAsync();
    }

    // ── 목록 표시

    private async Task RefreshAsync()
    {
        if (_refreshing)
            return;
        _refreshing = true;
        try
        {
            await Task.WhenAll(_instances.Select(i => i.RefreshAsync()));
        }
        finally
        {
            _refreshing = false;
        }
        RefreshList();
    }

    private void RefreshList()
    {
        var selected = Selected;
        _list.BeginUpdate();
        while (_list.Items.Count > _instances.Count)
            _list.Items.RemoveAt(_list.Items.Count - 1);
        for (var index = 0; index < _instances.Count; index++)
        {
            var instance = _instances[index];
            string[] cells =
            [
                StateText(instance.State),
                instance.Config.Name,
                instance.Config.Port.ToString(),
                AgentAddress(instance),
                instance.Config.ResolvedHttpsPort > 0 ? $"https://{NetInfo.LanAddress()}:{instance.Config.ResolvedHttpsPort}" : "",
                instance.Config.ResolvedDataDirectory,
                instance.Config.AutoStart ? "예" : "",
                instance.Message ?? "",
            ];
            ListViewItem item;
            if (index < _list.Items.Count)
            {
                item = _list.Items[index];
                for (var c = 0; c < cells.Length; c++)
                    if (item.SubItems[c].Text != cells[c])
                        item.SubItems[c].Text = cells[c];
            }
            else
            {
                item = new ListViewItem(cells);
                _list.Items.Add(item);
            }
            item.Tag = instance;
            item.ForeColor = StateColor(instance.State);
            if (ReferenceEquals(instance, selected))
                item.Selected = true;
        }
        _list.EndUpdate();

        _version.Text = VersionText();
        UpdateTrayIcon();
        UpdateButtons();
    }

    private void UpdateButtons()
    {
        var s = Selected;
        var hasServer = File.Exists(LauncherPaths.ServerExe);
        _add.Enabled = !_busy;
        _start.Enabled = !_busy && hasServer && s is { IsActive: false };
        _stop.Enabled = !_busy && s is { IsActive: true };
        _restart.Enabled = !_busy && hasServer && s is { State: InstanceState.Running or InstanceState.Starting };
        _edit.Enabled = !_busy && s is not null;
        _remove.Enabled = !_busy && s is not null;
        _open.Enabled = _copy.Enabled = s is { State: InstanceState.Running };
        _folder.Enabled = _logs.Enabled = s is not null;
        _startAll.Enabled = !_busy && hasServer && _instances.Any(i => !i.IsActive);
        _stopAll.Enabled = !_busy && _instances.Any(i => i.IsActive);
        _update.Enabled = _updateZip.Enabled = !_busy;
        _trust.Visible = _instances.Any(i => i.Config.ResolvedHttpsPort > 0) && !_certificateTrusted;
    }

    private string VersionText()
    {
        var installed = ServerPackage.InstalledVersion();
        var text = installed is null ? "서버: 없음" : $"서버: v{installed.ToString(3)}";
        if (_latest is not null && (installed is null || _latest > installed))
            text += $"  →  새 버전 v{_latest.ToString(3)}";
        else if (_latest is not null)
            text += " (최신)";
        return text;
    }

    private void UpdateTrayIcon()
    {
        var color = _instances.Any(i => i.State is InstanceState.Failed or InstanceState.PortBusy) ? Color.FromArgb(210, 60, 60)
            : _instances.Any(i => i.State is InstanceState.Running) ? Color.FromArgb(34, 160, 90)
            : _instances.Any(i => i.IsActive) ? Color.FromArgb(230, 160, 30)
            : Color.FromArgb(140, 146, 156);
        if (AppIcon.CurrentColor != color)
        {
            Icon = _tray.Icon = AppIcon.Create(color);
        }
        var running = _instances.Count(i => i.State is InstanceState.Running);
        _tray.Text = $"PC Manager 서버 런처 — 실행 중 {running}/{_instances.Count}";
    }

    private static string StateText(InstanceState state) => state switch
    {
        InstanceState.Running => "● 실행 중",
        InstanceState.Starting => "◐ 시작 중",
        InstanceState.Stopping => "◐ 중지 중",
        InstanceState.Failed => "✕ 오류",
        InstanceState.PortBusy => "✕ 포트 사용 중",
        _ => "○ 중지",
    };

    private static Color StateColor(InstanceState state) => state switch
    {
        InstanceState.Running => Color.FromArgb(22, 128, 70),
        InstanceState.Starting or InstanceState.Stopping => Color.FromArgb(180, 110, 0),
        InstanceState.Failed or InstanceState.PortBusy => Color.Firebrick,
        _ => Color.DimGray,
    };

    private static string AgentAddress(ServerInstance instance) => $"http://{NetInfo.LanAddress()}:{instance.Config.Port}";

    // ── 서버 추가 / 설정 / 삭제

    private void AddInstance()
    {
        var used = _instances.SelectMany(i => i.Config.Ports).ToHashSet();
        bool Free(int p) => !used.Contains(p) && !ServerInstance.IsPortListening(p);
        var port = DefaultPort;
        while (!Free(port) || !Free(port + 1))
            port += 2;
        using var dialog = new InstanceDialog(null, port, c => Validate(c, null));
        if (dialog.ShowDialog(this) != DialogResult.OK)
            return;

        var config = dialog.Result;
        _config.Instances.Add(config);
        Save();
        var instance = new ServerInstance(config, _job);
        _instances.Add(instance);
        if (dialog.OpenFirewall)
            OpenFirewall(config);
        if (config.ResolvedHttpsPort > 0)
            EnsureCertificate(askTrust: true);
        if (File.Exists(LauncherPaths.ServerExe))
            StartInstance(instance);
        RefreshList();
        SelectInstance(instance);
    }

    private async Task EditInstanceAsync()
    {
        if (Selected is not { } instance)
            return;
        var config = instance.Config;
        using var dialog = new InstanceDialog(config, config.Port, c => Validate(c, config));
        if (dialog.ShowDialog(this) != DialogResult.OK)
            return;

        var result = dialog.Result;
        var needsRestart = result.Port != config.Port || result.ResolvedHttpsPort != config.ResolvedHttpsPort
            || result.ResolvedDataDirectory != config.ResolvedDataDirectory;
        var wasActive = instance.IsActive;
        if (needsRestart && wasActive)
            await RunBusy($"{config.Name} 중지 중…", instance.StopAsync);

        config.Port = result.Port;
        config.HttpsPort = result.HttpsPort;
        config.DataDirectory = result.DataDirectory;
        config.AutoStart = result.AutoStart;
        Save();
        if (dialog.OpenFirewall)
            OpenFirewall(config);
        if (config.ResolvedHttpsPort > 0)
            EnsureCertificate(askTrust: true);
        if (needsRestart && wasActive)
            StartInstance(instance);
        RefreshList();
    }

    private async Task RemoveInstanceAsync()
    {
        if (Selected is not { } instance)
            return;
        var config = instance.Config;
        var customData = !string.IsNullOrWhiteSpace(config.DataDirectory);
        var answer = MessageBox.Show(this,
            $"서버 '{config.Name}'(포트 {config.Port})을(를) 목록에서 삭제합니다.\n\n" +
            (customData
                ? $"데이터 폴더({config.ResolvedDataDirectory})는 지우지 않습니다."
                : "[예] 데이터(DB·결과 파일)까지 삭제\n[아니요] 데이터는 남기고 목록에서만 삭제"),
            "서버 삭제", customData ? MessageBoxButtons.OKCancel : MessageBoxButtons.YesNoCancel, MessageBoxIcon.Warning);
        if (answer is DialogResult.Cancel)
            return;

        if (instance.IsActive)
            await RunBusy($"{config.Name} 중지 중…", instance.StopAsync);
        _instances.Remove(instance);
        _config.Instances.Remove(config);
        Save();
        if (answer is DialogResult.Yes)
        {
            try
            {
                Directory.Delete(LauncherPaths.InstanceDirectory(config.Name), recursive: true);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                MessageBox.Show(this, "데이터 폴더를 지우지 못했습니다: " + ex.Message, "서버 삭제", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
        RefreshList();
    }

    private string? Validate(InstanceConfig candidate, InstanceConfig? self)
    {
        if (self is null)
        {
            if (!NameRegex().IsMatch(candidate.Name))
                return "이름은 영문·숫자·-·_ 로 1~40자여야 합니다.";
            if (_config.Instances.Any(c => string.Equals(c.Name, candidate.Name, StringComparison.OrdinalIgnoreCase)))
                return "같은 이름의 서버가 이미 있습니다.";
        }
        if (candidate.ResolvedHttpsPort == candidate.Port)
            return "HTTPS 포트는 HTTP 포트와 달라야 합니다.";
        foreach (var port in candidate.Ports)
        {
            if (_config.Instances.FirstOrDefault(c => c != self && c.Ports.Contains(port)) is { } samePort)
                return $"포트 {port}은(는) '{samePort.Name}'이(가) 쓰고 있습니다.";
            if (self?.Ports.Contains(port) != true && ServerInstance.IsPortListening(port))
                return $"포트 {port}을(를) 다른 프로그램이 쓰고 있습니다.";
        }
        var data = Path.GetFullPath(candidate.ResolvedDataDirectory);
        if (_config.Instances.FirstOrDefault(c => c != self && string.Equals(Path.GetFullPath(c.ResolvedDataDirectory), data, StringComparison.OrdinalIgnoreCase)) is { } sameData)
            return $"데이터 폴더를 '{sameData.Name}'이(가) 쓰고 있습니다.";
        return null;
    }

    private void OpenFirewall(InstanceConfig config)
    {
        if (!Firewall.TryOpen(config.Name, config.Ports, out var error))
            SetStatus($"방화벽 규칙을 만들지 못했습니다: {error} (나중에 [설정]에서 다시 할 수 있습니다)");
        else
            SetStatus($"방화벽: TCP {string.Join(", ", config.Ports)} 허용 ({Firewall.RuleName(config.Name)})");
    }

    private void Save()
    {
        try
        {
            LauncherStore.Save(_config);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            MessageBox.Show(this, $"설정을 저장하지 못했습니다 ({LauncherPaths.ConfigFile}): {ex.Message}", Text,
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void SelectInstance(ServerInstance instance)
    {
        foreach (ListViewItem item in _list.Items)
            item.Selected = ReferenceEquals(item.Tag, instance);
    }

    // ── 실행 / 중지

    private void StartInstance(ServerInstance instance)
    {
        instance.Start();
        RefreshList();
    }

    private async Task RestartAsync(ServerInstance instance)
    {
        await instance.StopAsync();
        instance.Start();
    }

    private Task StopAllAsync() => Task.WhenAll(_instances.Where(i => i.IsActive).Select(i => i.StopAsync()));

    private async Task RunBusy(string message, Func<Task> action)
    {
        _busy = true;
        SetStatus(message);
        UpdateButtons();
        try
        {
            await action();
            SetStatus("");
        }
        catch (Exception ex)
        {
            SetStatus("실패: " + ex.Message);
        }
        finally
        {
            _busy = false;
            RefreshList();
        }
    }

    // ── 일괄 업데이트 (모든 서버가 같은 server 폴더를 쓴다)

    private async Task CheckLatestAsync()
    {
        try
        {
            _latest = await ServerPackage.LatestVersionAsync(CancellationToken.None);
            if (ServerPackage.InstalledVersion() is { } installed && _latest > installed)
                SetStatus($"새 서버 버전 v{_latest.ToString(3)}이(가) 있습니다. [일괄 업데이트]");
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or InvalidOperationException)
        {
            // 오프라인 등: 수동 확인 때 다시 알림
        }
        RefreshList();
    }

    private async Task UpdateFromGitHubAsync()
    {
        await RunBusy("최신 버전 확인 중…", async () =>
        {
            _latest = await ServerPackage.LatestVersionAsync(CancellationToken.None);
            var installed = ServerPackage.InstalledVersion();
            if (installed is not null && installed >= _latest)
            {
                MessageBox.Show(this, $"이미 최신 버전(v{installed.ToString(3)})입니다.", "일괄 업데이트", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (!ConfirmUpdate(installed, _latest))
                return;

            _progress.Value = 0;
            _progress.Visible = true;
            SetStatus($"v{_latest.ToString(3)} 다운로드 중…");
            var progress = new Progress<double>(p => _progress.Value = (int)Math.Clamp(p * 100, 0, 100));
            var zip = await ServerPackage.DownloadAsync(_latest, progress, CancellationToken.None);
            _progress.Visible = false;
            await InstallAsync(zip);
            ServerPackage.CleanupDownloads();
        });
        _progress.Visible = false;
    }

    private async Task UpdateFromZipAsync()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "서버 패키지 선택 (PcManager-Server-버전.zip)",
            Filter = "서버 패키지 (PcManager-Server-*.zip)|PcManager-Server-*.zip|zip 파일 (*.zip)|*.zip",
        };
        if (dialog.ShowDialog(this) != DialogResult.OK)
            return;
        await RunBusy("zip 확인 중…", async () =>
        {
            // 먼저 풀어 보고 버전을 확인한 뒤 교체할지 묻는다
            var version = await Task.Run(() => ServerPackage.Extract(dialog.FileName));
            if (!ConfirmUpdate(ServerPackage.InstalledVersion(), version))
                return;
            await InstallAsync(null);
        });
    }

    private bool ConfirmUpdate(Version? installed, Version? next)
    {
        var running = _instances.Count(i => i.IsActive);
        var message = $"서버를 {(installed is null ? "새로 설치" : $"v{installed.ToString(3)}에서")} " +
            $"v{next?.ToString(3) ?? "?"}{(installed is null ? "" : "(으)로 업데이트")}합니다.";
        if (running > 0)
            message += $"\n\n실행 중인 서버 {running}개가 잠시 중지됐다가 다시 시작됩니다.";
        return MessageBox.Show(this, message, "일괄 업데이트", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK;
    }

    /// <param name="zipPath">null이면 이미 server.new에 풀려 있음</param>
    private async Task InstallAsync(string? zipPath)
    {
        if (zipPath is not null)
        {
            SetStatus("압축 푸는 중…");
            await Task.Run(() => ServerPackage.Extract(zipPath));
        }

        var wasActive = _instances.Where(i => i.IsActive).ToList();
        SetStatus($"서버 {wasActive.Count}개 중지 중…");
        await Task.WhenAll(wasActive.Select(i => i.StopAsync()));

        SetStatus("서버 파일 교체 중…");
        await ServerPackage.SwapAsync();

        foreach (var instance in wasActive)
            instance.Start();
        var version = ServerPackage.InstalledVersion();
        MessageBox.Show(this, $"서버를 v{version?.ToString(3)}(으)로 바꿨습니다." +
            (wasActive.Count > 0 ? $"\n서버 {wasActive.Count}개를 다시 시작했습니다." : "") +
            "\n\n에이전트는 각 대시보드의 업데이트 창에서 올릴 수 있습니다.",
            "일괄 업데이트", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    // ── 열기

    private void OpenDashboard()
    {
        if (Selected is not { State: InstanceState.Running } instance)
            return;
        var https = instance.Config.ResolvedHttpsPort;
        OpenPath(https > 0 && ServerCertificate.Exists ? $"https://localhost:{https}/" : $"http://localhost:{instance.Config.Port}/");
    }

    // ── HTTPS 인증서 (모든 서버가 같이 씀)

    /// <summary>인증서를 준비하고, 이 PC가 아직 신뢰하지 않으면 신뢰할지 묻는다</summary>
    private void EnsureCertificate(bool askTrust)
    {
        if (!_instances.Any(i => i.Config.ResolvedHttpsPort > 0))
            return;
        try
        {
            if (ServerCertificate.Ensure())
                SetStatus("HTTPS 인증서를 만들었습니다 (이 PC 이름·IP용). 에이전트는 다시 연결될 때 자동으로 신뢰합니다.");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Security.Cryptography.CryptographicException)
        {
            SetStatus("HTTPS 인증서를 만들지 못했습니다: " + ex.Message);
            return;
        }
        _certificateTrusted = ServerCertificate.IsTrustedHere();
        if (!_certificateTrusted && askTrust && MessageBox.Show(this,
                "이 PC에서 대시보드를 HTTPS로 경고 없이 열려면 서버 인증서를 신뢰 저장소에 넣어야 합니다 (관리자 승인 한 번).\n\n지금 넣을까요?",
                "HTTPS 인증서", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
            TrustCertificate();
        UpdateButtons();
    }

    private void TrustCertificate()
    {
        if (ServerCertificate.TryTrustHere(out var error))
            SetStatus("이 PC가 HTTPS 인증서를 신뢰합니다. 열려 있던 브라우저는 다시 열어야 반영됩니다.");
        else
            SetStatus("인증서 신뢰 실패: " + error);
        _certificateTrusted = ServerCertificate.IsTrustedHere();
        UpdateButtons();
    }

    private void OpenPath(string target)
    {
        try
        {
            if (!target.StartsWith("http", StringComparison.OrdinalIgnoreCase) && !File.Exists(target) && !Directory.Exists(target))
            {
                SetStatus("아직 없습니다: " + target);
                return;
            }
            Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            SetStatus(ex.Message);
        }
    }

    private void SetStatus(string text) => _status.Text = text;

    // ── 창 닫기 = 트레이로 / 종료

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_exiting && e.CloseReason == CloseReason.UserClosing && _instances.Any(i => i.IsActive))
        {
            e.Cancel = true;
            Hide();
            if (!_trayHintShown)
            {
                _trayHintShown = true;
                _tray.ShowBalloonTip(3000, "PC Manager 서버 런처", "서버는 계속 실행됩니다. 종료는 트레이 아이콘 메뉴에서 합니다.", ToolTipIcon.Info);
            }
            return;
        }
        if (!_exiting)
        {
            // 실행 중인 서버가 없거나 Windows 종료: 바로 끝낸다 (잡이 닫히며 남은 서버도 함께 종료)
            _tray.Visible = false;
        }
        base.OnFormClosing(e);
    }

    private async Task ExitAsync()
    {
        var running = _instances.Count(i => i.IsActive);
        if (running > 0)
        {
            ShowFromTray();
            if (MessageBox.Show(this, $"실행 중인 서버 {running}개가 모두 종료됩니다. 런처를 끝낼까요?", Text,
                    MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK)
                return;
            await RunBusy("서버 종료 중…", StopAllAsync);
        }
        _exiting = true;
        _tray.Visible = false;
        Close();
    }

    private void ShowFromTray()
    {
        Show();
        if (WindowState == FormWindowState.Minimized)
            WindowState = FormWindowState.Normal;
        Activate();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _timer.Dispose();
            _tray.Dispose();
            _job.Dispose();
        }
        base.Dispose(disposing);
    }

    private static FlowLayoutPanel Row() =>
        new() { AutoSize = true, WrapContents = false, Dock = DockStyle.Fill, Margin = new Padding(0, 0, 0, 8) };

    private static Button Styled(Button button)
    {
        button.AutoSize = true;
        button.Margin = new Padding(0, 0, 6, 0);
        return button;
    }

    [GeneratedRegex("^[A-Za-z0-9_-]{1,40}$")]
    private static partial Regex NameRegex();
}

/// <summary>서버 모양 아이콘 + 상태 점 (이미지 파일 없이 코드로 그림)</summary>
internal static class AppIcon
{
    public static Color? CurrentColor { get; private set; }

    public static Icon Create(Color statusColor)
    {
        CurrentColor = statusColor;
        using var bitmap = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using var frame = new SolidBrush(Color.FromArgb(55, 65, 81));
            using var light = new SolidBrush(Color.FromArgb(147, 197, 253));
            for (var y = 3; y <= 19; y += 8)
            {
                g.FillRectangle(frame, 3, y, 22, 7);
                g.FillRectangle(light, 6, y + 2, 3, 3);
            }
            using var outline = new SolidBrush(Color.White);
            using var dot = new SolidBrush(statusColor);
            g.FillEllipse(outline, 16, 16, 16, 16);
            g.FillEllipse(dot, 18, 18, 12, 12);
        }
        // 상태가 바뀔 때만 만들며 개수가 적어 핸들을 해제하지 않는다
        return Icon.FromHandle(bitmap.GetHicon());
    }
}
