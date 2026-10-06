using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Security.Cryptography;
using System.Text;

namespace PcManager.ServerLauncher;

internal enum InstanceState
{
    Stopped,
    Starting,
    Running,
    Stopping,
    /// <summary>반복해서 비정상 종료돼 자동 재시작을 멈춤</summary>
    Failed,
    /// <summary>런처가 띄우지 않은 프로그램이 같은 포트를 쓰고 있음</summary>
    PortBusy,
}

/// <summary>인스턴스 하나의 실행 상태. 서버는 런처의 자식 프로세스로 잡에 묶인다</summary>
internal sealed class ServerInstance
{
    // 서버 PcManager.Server.Api.LauncherEndpoints와 맞춘다
    private const string TokenVariable = "PCM_LAUNCHER_TOKEN";
    private const string TokenHeader = "X-Launcher-Token";
    private const long MaxLogBytes = 5 * 1024 * 1024;
    private const int MaxCrashesInWindow = 3;
    private static readonly TimeSpan CrashWindow = TimeSpan.FromMinutes(5);

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(2) };

    private readonly JobObject _job;
    private readonly object _lock = new();
    private readonly List<DateTime> _crashes = [];
    private Process? _process;
    private StreamWriter? _log;
    private string _token = "";
    private bool _stopRequested;

    public ServerInstance(InstanceConfig config, JobObject job)
    {
        Config = config;
        _job = job;
    }

    public InstanceConfig Config { get; }
    public InstanceState State { get; private set; } = InstanceState.Stopped;
    public string? Message { get; private set; }
    public DateTime? StartedAt { get; private set; }

    public bool IsActive => State is InstanceState.Starting or InstanceState.Running or InstanceState.Stopping;

    public void Start()
    {
        lock (_lock)
        {
            if (_process is { HasExited: false })
                return;
            _stopRequested = false;
            _crashes.Clear();
            Launch();
        }
    }

    private void Launch()
    {
        if (!File.Exists(LauncherPaths.ServerExe))
        {
            SetState(InstanceState.Failed, "서버 파일이 없습니다. [일괄 업데이트]로 먼저 받으세요.");
            return;
        }
        if (IsPortListening(Config.Port))
        {
            SetState(InstanceState.PortBusy, $"포트 {Config.Port}을(를) 다른 프로그램이 쓰고 있습니다.");
            return;
        }

        Directory.CreateDirectory(LauncherPaths.InstanceDirectory(Config.Name));
        Directory.CreateDirectory(Config.ResolvedDataDirectory);
        OpenLog();

        _token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        var info = new ProcessStartInfo(LauncherPaths.ServerExe)
        {
            WorkingDirectory = LauncherPaths.ServerDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        info.ArgumentList.Add("--port");
        info.ArgumentList.Add(Config.Port.ToString());
        info.ArgumentList.Add("--data");
        info.ArgumentList.Add(Config.ResolvedDataDirectory);
        info.Environment[TokenVariable] = _token;

        try
        {
            var process = new Process { StartInfo = info, EnableRaisingEvents = true };
            process.OutputDataReceived += (_, e) => WriteLog(e.Data);
            process.ErrorDataReceived += (_, e) => WriteLog(e.Data);
            process.Exited += (_, _) => OnExited(process);
            process.Start();
            _job.Add(process);
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            _process = process;
            StartedAt = DateTime.Now;
            WriteLog($"[launcher] 시작: 포트 {Config.Port}, 데이터 {Config.ResolvedDataDirectory} (PID {process.Id})");
            SetState(InstanceState.Starting, null);
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            SetState(InstanceState.Failed, "시작 실패: " + ex.Message);
        }
    }

    private void OnExited(Process process)
    {
        lock (_lock)
        {
            if (!ReferenceEquals(process, _process))
                return;
            var code = SafeExitCode(process);
            _process = null;
            StartedAt = null;
            if (_stopRequested)
            {
                WriteLog("[launcher] 종료됨");
                CloseLog();
                SetState(InstanceState.Stopped, null);
                return;
            }

            // 비정상 종료: 잠깐 뒤 다시 띄운다. 짧은 시간에 반복되면 멈추고 알린다
            WriteLog($"[launcher] 비정상 종료 (코드 {code})");
            var now = DateTime.Now;
            _crashes.RemoveAll(t => now - t > CrashWindow);
            _crashes.Add(now);
            if (_crashes.Count >= MaxCrashesInWindow)
            {
                CloseLog();
                SetState(InstanceState.Failed, $"{CrashWindow.TotalMinutes:0}분 안에 {_crashes.Count}번 종료돼 자동 재시작을 멈췄습니다. 로그를 확인하세요.");
                return;
            }
            SetState(InstanceState.Starting, $"비정상 종료(코드 {code}) — 다시 시작하는 중");
        }
        _ = RestartAfterCrashAsync();
    }

    private async Task RestartAfterCrashAsync()
    {
        await Task.Delay(3000);
        lock (_lock)
        {
            if (_stopRequested || _process is not null)
                return;
            Launch();
        }
    }

    /// <summary>서버에 정상 종료를 요청하고, 응답이 없으면 강제로 끝낸다</summary>
    public async Task StopAsync()
    {
        Process? process;
        string token;
        lock (_lock)
        {
            _stopRequested = true;
            process = _process;
            token = _token;
            if (process is null)
            {
                if (State is not InstanceState.PortBusy)
                    SetState(InstanceState.Stopped, null);
                return;
            }
            SetState(InstanceState.Stopping, null);
        }

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{Config.Port}/api/launcher/shutdown");
            request.Headers.Add(TokenHeader, token);
            using var _ = await Http.SendAsync(request);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            // 응답하지 않는 서버 → 아래에서 강제 종료
        }

        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            WriteLog("[launcher] 정상 종료 응답 없음 → 강제 종료");
            try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            await process.WaitForExitAsync();
        }
    }

    /// <summary>주기적으로 호출: 프로세스가 떠 있으면 HTTP 응답으로 '시작 중/실행 중'을 가리고, 꺼져 있으면 포트 점유를 확인한다</summary>
    public async Task RefreshAsync()
    {
        var process = _process;
        if (process is { HasExited: false })
        {
            if (State is InstanceState.Stopping)
                return;
            var ok = await RespondsAsync();
            lock (_lock)
            {
                if (ReferenceEquals(process, _process) && State is InstanceState.Starting or InstanceState.Running)
                    SetState(ok ? InstanceState.Running : InstanceState.Starting, ok ? null : Message);
            }
            return;
        }
        if (process is null && State is InstanceState.Stopped or InstanceState.PortBusy)
        {
            var busy = IsPortListening(Config.Port);
            SetState(busy ? InstanceState.PortBusy : InstanceState.Stopped,
                busy ? $"포트 {Config.Port}을(를) 다른 프로그램이 쓰고 있습니다." : null);
        }
    }

    private async Task<bool> RespondsAsync()
    {
        try
        {
            using var response = await Http.GetAsync($"http://127.0.0.1:{Config.Port}/api/install/info");
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return false;
        }
    }

    public static bool IsPortListening(int port) =>
        IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Any(e => e.Port == port);

    private void SetState(InstanceState state, string? message)
    {
        State = state;
        Message = message;
    }

    private static int? SafeExitCode(Process process)
    {
        try { return process.ExitCode; } catch (InvalidOperationException) { return null; }
    }

    // ── 로그: instances\이름\server.log (5MB 넘으면 시작할 때 server.log.1로 넘김)
    private void OpenLog()
    {
        CloseLog();
        var path = LauncherPaths.LogFile(Config.Name);
        try
        {
            if (File.Exists(path) && new FileInfo(path).Length > MaxLogBytes)
                File.Move(path, path + ".1", overwrite: true);
            _log = new StreamWriter(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false))
            {
                AutoFlush = true,
            };
        }
        catch (IOException)
        {
            _log = null;
        }
    }

    private void WriteLog(string? line)
    {
        if (line is null)
            return;
        lock (_lock)
        {
            try { _log?.WriteLine($"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {line}"); } catch (IOException) { } catch (ObjectDisposedException) { }
        }
    }

    private void CloseLog()
    {
        _log?.Dispose();
        _log = null;
    }
}
