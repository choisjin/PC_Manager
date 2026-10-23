using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using PcManager.Shared;

namespace PcManager.Agent;

/// <summary>
/// PC 정보 패널 (PC 목록 아래): 시스템 정보·디스크·프로세스·성능·장치. 대시보드가 보고 있을 때만 잰다.
/// 성능은 첫 요청에 1초 간격 측정을 시작해 10초 동안 요청이 없으면 멈추고, 프로세스는 1.5초 안에 다시 물으면 저번 목록을 준다
/// (여러 사람이 같은 PC를 봐도 한 번만 잰다). 운영체제별 읽기는 SystemMonitor.Windows.cs · SystemMonitor.Linux.cs
/// </summary>
public sealed partial class SystemMonitor(ILogger<SystemMonitor> logger)
{
    private const int HistorySize = 60;
    private static readonly TimeSpan SampleInterval = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan IdleStop = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan ProcessReuse = TimeSpan.FromSeconds(1.5);
    // 저번 프로세스 목록이 이보다 오래됐으면 CPU를 재려고 잠깐 기다렸다 다시 읽는다
    private static readonly TimeSpan ProcessBaseline = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan BaselineWait = TimeSpan.FromMilliseconds(500);

    private readonly Lock _perfGate = new();
    private readonly List<PerfSample> _history = [];
    private long _seq;
    private long _lastPerfRequest;
    private string? _session;

    private readonly SemaphoreSlim _processGate = new(1, 1);
    private Dictionary<(int Id, long Start), long> _lastCpu = [];
    private long _lastCpuAt;
    private ProcessList? _lastList;
    private long _lastListAt;

    public PcSystemInfo GetSystemInfo() => ReadSystemInfo();

    public DeviceList GetDevices() => ReadDevices();

    public async Task<ProcessList> GetProcessesAsync()
    {
        await _processGate.WaitAsync();
        try
        {
            if (_lastList is not null && Stopwatch.GetElapsedTime(_lastListAt) < ProcessReuse)
                return _lastList;
            if (_lastCpu.Count == 0 || Stopwatch.GetElapsedTime(_lastCpuAt) > ProcessBaseline)
            {
                Remember(ReadProcesses(), Stopwatch.GetTimestamp());
                await Task.Delay(BaselineWait);
            }

            var list = ReadProcesses();
            var at = Stopwatch.GetTimestamp();
            // CPU 시간은 100ns 단위 → 지난 시간 × 논리 코어 수에 대한 비율
            var capacity = (double)Stopwatch.GetElapsedTime(_lastCpuAt, at).Ticks * Environment.ProcessorCount;
            var items = new List<ProcessEntry>(list.Count);
            foreach (var p in list)
            {
                var cpu = capacity > 0 && _lastCpu.TryGetValue((p.Id, p.Start), out var before)
                    ? Percent((p.CpuTime - before) * 100.0 / capacity)
                    : 0;
                items.Add(new ProcessEntry(p.Id, p.Name, cpu, p.Memory));
            }
            Remember(list, at);
            _lastList = new ProcessList(items);
            _lastListAt = at;
            return _lastList;
        }
        finally
        {
            _processGate.Release();
        }
    }

    private void Remember(List<RawProcess> list, long at)
    {
        var map = new Dictionary<(int, long), long>(list.Count);
        foreach (var p in list)
            map[(p.Id, p.Start)] = p.CpuTime;
        _lastCpu = map;
        _lastCpuAt = at;
    }

    /// <param name="after">대시보드가 이미 받은 마지막 측정 번호</param>
    public PerfHistory GetPerformance(long after)
    {
        lock (_perfGate)
        {
            _lastPerfRequest = Environment.TickCount64;
            if (_session is null)
            {
                _session = Guid.NewGuid().ToString("N")[..8];
                _history.Clear();
                var session = _session;
                _ = Task.Run(() => SampleLoopAsync(session));
            }
            return new PerfHistory(_session, _history.Where(s => s.Seq > after).ToList());
        }
    }

    private async Task SampleLoopAsync(string session)
    {
        IPerfReader? reader = null;
        try
        {
            reader = OpenPerf();
            var last = Stopwatch.GetTimestamp();
            using var timer = new PeriodicTimer(SampleInterval);
            while (await timer.WaitForNextTickAsync())
            {
                var now = Stopwatch.GetTimestamp();
                var sample = reader.Read(Stopwatch.GetElapsedTime(last, now).TotalSeconds);
                last = now;
                lock (_perfGate)
                {
                    // 아무도 보지 않으면 멈춘다 (다음 요청에 새로 시작)
                    if (Environment.TickCount64 - _lastPerfRequest > IdleStop.TotalMilliseconds)
                    {
                        _session = null;
                        _history.Clear();
                        return;
                    }
                    _history.Add(sample with { Seq = ++_seq });
                    if (_history.Count > HistorySize)
                        _history.RemoveAt(0);
                }
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning("성능 측정 실패: {Message}", ex.Message);
            lock (_perfGate)
            {
                if (_session == session)
                    _session = null;
            }
        }
        finally
        {
            reader?.Dispose();
        }
    }

    /// <param name="Start">프로세스 시작 시각 (번호를 다시 쓴 프로세스 구분)</param>
    /// <param name="CpuTime">지금까지 쓴 CPU 시간 (100ns 단위)</param>
    private readonly record struct RawProcess(int Id, string Name, long Start, long CpuTime, long Memory);

    private interface IPerfReader : IDisposable
    {
        /// <param name="seconds">저번 측정 뒤 지난 시간</param>
        PerfSample Read(double seconds);
    }

    private partial PcSystemInfo ReadSystemInfo();

    private partial List<RawProcess> ReadProcesses();

    /// <summary>측정 시작 (카운터를 열고 비교할 첫 값을 읽는다)</summary>
    private partial IPerfReader OpenPerf();

    private partial DeviceList ReadDevices();

    private static double Percent(double value) => Math.Round(Math.Clamp(value, 0, 100), 1);

    private static string Architecture() => RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant();

    private static string? Join(params string?[] parts)
    {
        var text = string.Join(" · ", parts.Where(p => !string.IsNullOrWhiteSpace(p)).Select(p => p!.Trim()));
        return text.Length > 0 ? text : null;
    }

    // 조립 PC·메인보드 기본값
    private static readonly string[] Placeholders =
        ["O.E.M", "Default string", "System Product Name", "System manufacturer", "System Version", "To be filled", "Not Specified", "Not Applicable"];

    private static string? Clean(string? text) =>
        string.IsNullOrWhiteSpace(text) || Placeholders.Any(p => text.Contains(p, StringComparison.OrdinalIgnoreCase)) ? null : text.Trim();

    /// <summary>제조사·모델. 조립 PC처럼 모델이 기본값("To Be Filled By O.E.M.")이면 메인보드 정보로</summary>
    private static (string? Maker, string? Model) Board(string? maker, string? model, string? boardMaker, string? boardModel) =>
        Clean(model) is { } m ? (Clean(maker) ?? Clean(boardMaker), m) : (Clean(boardMaker) ?? Clean(maker), Clean(boardModel));

    /// <summary>드라이브 (Linux는 장치·가상 파일 시스템 마운트 제외)</summary>
    private static List<DriveDetail> ReadDrives()
    {
        var list = new List<DriveDetail>();
        foreach (var d in DriveInfo.GetDrives())
        {
            try
            {
                var type = d.DriveType switch
                {
                    DriveType.Fixed => "fixed",
                    DriveType.Removable => "removable",
                    DriveType.Network => "network",
                    DriveType.CDRom => "cdrom",
                    _ => null,
                };
                if (type is null || !d.IsReady || d.TotalSize <= 0)
                    continue;
                if (!OperatingSystem.IsWindows()
                    && (VideoTrimmer.SkipMounts.Any(m => d.Name == m || d.Name.StartsWith(m + "/", StringComparison.Ordinal))
                        || d.DriveFormat is "overlay" or "squashfs" or "tmpfs" or "devtmpfs"))
                    continue;
                var label = OperatingSystem.IsWindows() && !string.IsNullOrWhiteSpace(d.VolumeLabel) ? d.VolumeLabel : null;
                list.Add(new DriveDetail(d.Name, label, type, d.DriveFormat, d.AvailableFreeSpace, d.TotalSize));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // 읽을 수 없는 드라이브는 건너뛴다
            }
        }
        return list;
    }

    /// <summary>네트워크 송수신 속도. 장치 목록은 30초마다만 다시 읽는다 (매번 읽으면 20ms 넘게 걸림)</summary>
    private sealed class NetworkRate
    {
        private static readonly TimeSpan Refresh = TimeSpan.FromSeconds(30);
        private NetworkInterface[] _interfaces = [];
        private long _listedAt;
        private readonly Dictionary<string, (long Received, long Sent)> _last = [];

        public (double Receive, double Send) Read(double seconds)
        {
            if (_interfaces.Length == 0 || Environment.TickCount64 - _listedAt > Refresh.TotalMilliseconds)
            {
                _interfaces = List();
                _listedAt = Environment.TickCount64;
            }
            double receive = 0, send = 0;
            foreach (var n in _interfaces)
            {
                long received, sent;
                try
                {
                    var stats = n.GetIPStatistics();
                    (received, sent) = (stats.BytesReceived, stats.BytesSent);
                }
                catch (Exception ex) when (ex is NetworkInformationException or PlatformNotSupportedException)
                {
                    continue; // 그 사이 사라진 장치
                }
                if (seconds > 0 && _last.TryGetValue(n.Id, out var before))
                {
                    receive += Math.Max(0, received - before.Received) / seconds;
                    send += Math.Max(0, sent - before.Sent) / seconds;
                }
                _last[n.Id] = (received, sent);
            }
            return (Math.Round(receive), Math.Round(send));
        }

        private static NetworkInterface[] List()
        {
            try
            {
                return NetworkInterface.GetAllNetworkInterfaces()
                    .Where(n => n.OperationalStatus == OperationalStatus.Up
                        && n.NetworkInterfaceType is not (NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel))
                    .ToArray();
            }
            catch (NetworkInformationException)
            {
                return [];
            }
        }
    }
}
