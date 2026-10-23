using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using PcManager.Shared;

namespace PcManager.Agent;

// Linux: /proc · /sys 파일을 읽는다 (PCI 장치 이름은 lspci가 있으면 쓴다)
public sealed partial class SystemMonitor
{
    // /proc/<pid>/stat의 CPU 시간 단위(클록 틱) → 100ns
    private static readonly long TickTo100ns = 10_000_000 / ClockTicks();

    private partial PcSystemInfo ReadSystemInfo()
    {
        var release = KeyValues("/etc/os-release");
        var os = release.GetValueOrDefault("PRETTY_NAME") ?? release.GetValueOrDefault("NAME") ?? "Linux";
        var (maker, model) = Board(Dmi("sys_vendor"), Dmi("product_name"), Dmi("board_vendor"), Dmi("board_name"));
        // DMI가 없는 ARM 보드 (라즈베리 파이 등)
        model ??= ReadLine("/proc/device-tree/model")?.TrimEnd('\0');
        var (cpu, cores) = CpuInfo();
        var gpus = Pci().Where(d => d.Class.StartsWith("03", StringComparison.Ordinal)).Select(d => d.Name).ToList();
        return new PcSystemInfo("linux", Environment.MachineName, os, null,
            ReadLine("/proc/sys/kernel/osrelease") ?? Environment.OSVersion.Version.ToString(), Architecture(), maker, model,
            Join(Dmi("bios_version"), Dmi("bios_date")), cpu, cores, Environment.ProcessorCount, MemInfo().GetValueOrDefault("MemTotal"),
            gpus, BootTime(), Users(), ReadDrives());
    }

    private static string? Dmi(string name) => ReadLine("/sys/class/dmi/id/" + name);

    /// <summary>/etc/os-release 형식 (KEY="값")</summary>
    private static Dictionary<string, string> KeyValues(string path)
    {
        var map = new Dictionary<string, string>();
        try
        {
            foreach (var line in File.ReadLines(path))
            {
                var eq = line.IndexOf('=');
                if (eq > 0)
                    map[line[..eq].Trim()] = line[(eq + 1)..].Trim().Trim('"', '\'');
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 없는 배포판
        }
        return map;
    }

    private static (string Name, int Cores) CpuInfo()
    {
        string? name = null;
        var physical = "0";
        var cores = new HashSet<(string, string)>();
        try
        {
            foreach (var line in File.ReadLines("/proc/cpuinfo"))
            {
                var colon = line.IndexOf(':');
                if (colon < 0)
                    continue;
                var value = line[(colon + 1)..].Trim();
                switch (line[..colon].Trim())
                {
                    case "model name" or "Hardware" or "Model" when name is null && value.Length > 0:
                        name = value;
                        break;
                    case "physical id":
                        physical = value;
                        break;
                    case "core id":
                        cores.Add((physical, value));
                        break;
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 모름
        }
        return (name ?? "", cores.Count);
    }

    /// <summary>/proc/meminfo (kB는 바이트로)</summary>
    private static Dictionary<string, long> MemInfo()
    {
        var map = new Dictionary<string, long>();
        try
        {
            foreach (var line in File.ReadLines("/proc/meminfo"))
            {
                var colon = line.IndexOf(':');
                if (colon <= 0)
                    continue;
                var value = line[(colon + 1)..].Trim();
                var space = value.IndexOf(' ');
                if (long.TryParse(space > 0 ? value[..space] : value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number))
                    map[line[..colon]] = value.EndsWith("kB", StringComparison.Ordinal) ? number * 1024 : number;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 모름
        }
        return map;
    }

    private static DateTime BootTime()
    {
        try
        {
            foreach (var line in File.ReadLines("/proc/stat"))
            {
                if (line.StartsWith("btime ", StringComparison.Ordinal)
                    && long.TryParse(line.AsSpan(6), NumberStyles.Integer, CultureInfo.InvariantCulture, out var seconds))
                    return DateTimeOffset.FromUnixTimeSeconds(seconds).UtcDateTime;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 아래 방법으로
        }
        return DateTime.UtcNow - TimeSpan.FromMilliseconds(Environment.TickCount64);
    }

    /// <summary>로그인한 사용자 (who: 화면·터미널·SSH)</summary>
    private static List<string> Users() =>
        Run("who", "")?.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Split(' ', 2)[0]).Where(user => user.Length > 0).Distinct().ToList() ?? [];

    private partial List<RawProcess> ReadProcesses()
    {
        var list = new List<RawProcess>(256);
        var pageSize = Environment.SystemPageSize;
        foreach (var dir in Entries("/proc"))
        {
            if (!int.TryParse(Path.GetFileName(dir), NumberStyles.None, CultureInfo.InvariantCulture, out var id))
                continue;
            try
            {
                // "pid (이름) 상태 ppid …": 이름에 공백·괄호가 있을 수 있어 마지막 ')' 뒤를 나눈다
                var stat = File.ReadAllText($"/proc/{id}/stat");
                var open = stat.IndexOf('(');
                var close = stat.LastIndexOf(')');
                if (open < 0 || close < open || close + 2 >= stat.Length)
                    continue;
                var fields = stat[(close + 2)..].Split(' ');
                // fields[0] = 3번째 필드(상태) · 4 ppid · 14 utime · 15 stime · 22 starttime
                var parent = int.Parse(fields[1], CultureInfo.InvariantCulture);
                if (id == 2 || parent == 2)
                    continue; // 커널 스레드
                var cpu = long.Parse(fields[11], CultureInfo.InvariantCulture) + long.Parse(fields[12], CultureInfo.InvariantCulture);
                var start = long.Parse(fields[19], CultureInfo.InvariantCulture);
                // statm: 전체 상주 공유 … (페이지) → 공유 페이지를 뺀 상주 메모리
                var statm = File.ReadAllText($"/proc/{id}/statm").Split(' ');
                var memory = (long.Parse(statm[1], CultureInfo.InvariantCulture) - long.Parse(statm[2], CultureInfo.InvariantCulture)) * pageSize;
                list.Add(new RawProcess(id, stat[(open + 1)..close], start, cpu * TickTo100ns, Math.Max(0, memory)));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or FormatException or IndexOutOfRangeException)
            {
                // 그 사이 끝난 프로세스
            }
        }
        return list;
    }

    private partial IPerfReader OpenPerf() => new LinuxPerf();

    private sealed class LinuxPerf : IPerfReader
    {
        private readonly HashSet<string> _disks = PhysicalDisks();
        private readonly NetworkRate _network = new();
        private (long Idle, long Total) _cpu = CpuTimes();
        private Dictionary<string, (long Read, long Write, long Busy)> _io;

        public LinuxPerf()
        {
            _io = DiskStats(_disks);
            _network.Read(0);
        }

        public PerfSample Read(double seconds)
        {
            var cpu = CpuTimes();
            var usage = cpu.Total > _cpu.Total ? 100.0 * (1 - (double)(cpu.Idle - _cpu.Idle) / (cpu.Total - _cpu.Total)) : 0;
            _cpu = cpu;
            var memory = MemInfo();
            var total = memory.GetValueOrDefault("MemTotal");
            var available = memory.TryGetValue("MemAvailable", out var a) ? a : memory.GetValueOrDefault("MemFree") + memory.GetValueOrDefault("Cached");

            var io = DiskStats(_disks);
            double read = 0, write = 0, active = 0;
            if (seconds > 0)
            {
                foreach (var (name, now) in io)
                {
                    if (!_io.TryGetValue(name, out var before))
                        continue;
                    read += Math.Max(0, now.Read - before.Read) / seconds;
                    write += Math.Max(0, now.Write - before.Write) / seconds;
                    // I/O 하던 시간(ms) / 지난 시간 → 가장 바쁜 디스크
                    active = Math.Max(active, (now.Busy - before.Busy) / (seconds * 10));
                }
            }
            _io = io;
            var (receive, send) = _network.Read(seconds);
            return new PerfSample(0, Percent(usage), Math.Max(0, total - available), total, Math.Round(read), Math.Round(write),
                Percent(active), receive, send, null);
        }

        public void Dispose()
        {
            // 열어 둔 것 없음
        }
    }

    private static (long Idle, long Total) CpuTimes()
    {
        try
        {
            var line = File.ReadLines("/proc/stat").FirstOrDefault(l => l.StartsWith("cpu ", StringComparison.Ordinal));
            if (line is null)
                return (0, 0);
            // user nice system idle iowait irq softirq steal
            var v = line.Split(' ', StringSplitOptions.RemoveEmptyEntries).Skip(1).Take(8)
                .Select(s => long.Parse(s, CultureInfo.InvariantCulture)).ToArray();
            return v.Length < 5 ? (0, 0) : (v[3] + v[4], v.Sum());
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or FormatException)
        {
            return (0, 0);
        }
    }

    /// <summary>실제 디스크 (loop·ram·dm 같은 가상 장치는 device가 없다)</summary>
    private static HashSet<string> PhysicalDisks() =>
        Entries("/sys/block").Where(path => Directory.Exists(path + "/device")).Select(Path.GetFileName).OfType<string>().ToHashSet();

    private static Dictionary<string, (long Read, long Write, long Busy)> DiskStats(HashSet<string> disks)
    {
        var map = new Dictionary<string, (long, long, long)>();
        try
        {
            foreach (var line in File.ReadLines("/proc/diskstats"))
            {
                var f = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (f.Length < 13 || !disks.Contains(f[2]))
                    continue;
                // 섹터(512바이트): 읽은 [5] · 쓴 [9] / I/O 하던 시간(ms) [12]
                map[f[2]] = (long.Parse(f[5], CultureInfo.InvariantCulture) * 512, long.Parse(f[9], CultureInfo.InvariantCulture) * 512,
                    long.Parse(f[12], CultureInfo.InvariantCulture));
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or FormatException)
        {
            // 모름
        }
        return map;
    }

    private partial DeviceList ReadDevices()
    {
        var items = new List<DeviceEntry>();
        foreach (var d in Pci())
        {
            // 드라이버가 있어야 하는 종류만 '드라이버 없음'으로 (브리지 등은 드라이버 없이 동작)
            var needsDriver = d.Class.Length >= 2 && d.Class[..2] is "01" or "02" or "03" or "04" or "0d" || d.Class == "0c03";
            var problem = needsDriver && !Directory.Exists($"/sys/bus/pci/devices/{d.Slot}/driver") ? 28 : 0;
            items.Add(new DeviceEntry(PciCategory(d.Class), d.Name, d.Vendor, problem, d.Slot));
        }
        AddUsb(items);
        AddSerial(items);
        AddDisks(items);
        AddInput(items);
        return new DeviceList(items);
    }

    /// <param name="Class">PCI 종류 번호 4자리 ("0300")</param>
    private readonly record struct PciDevice(string Slot, string Class, string Name, string? Vendor);

    private static List<PciDevice> Pci()
    {
        var list = new List<PciDevice>();
        // 0000:00:02.0 "VGA compatible controller [0300]" "Intel Corporation [8086]" "HD Graphics 630 [5912]" -r04 "Lenovo [17aa]" "Device [3138]"
        if (Run("lspci", "-mm -nn -D") is { } output)
        {
            foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                var fields = QuotedRegex().Matches(line).Select(m => m.Groups[1].Value).ToList();
                if (fields.Count < 3)
                    continue;
                var (_, classCode) = SplitId(fields[0]);
                var (vendor, _) = SplitId(fields[1]);
                var (device, _) = SplitId(fields[2]);
                list.Add(new PciDevice(line.Split(' ', 2)[0], classCode ?? "", $"{vendor} {device}".Trim(), vendor));
            }
            if (list.Count > 0)
                return list;
        }
        // lspci가 없으면 sysfs의 번호만
        foreach (var path in Entries("/sys/bus/pci/devices"))
        {
            var classCode = ReadLine(path + "/class") is { Length: >= 6 } c ? c[2..6] : "";
            var vendor = ReadLine(path + "/vendor")?.Replace("0x", "", StringComparison.Ordinal);
            var device = ReadLine(path + "/device")?.Replace("0x", "", StringComparison.Ordinal);
            list.Add(new PciDevice(Path.GetFileName(path), classCode, $"PCI 장치 {vendor}:{device}", null));
        }
        return list;
    }

    /// <summary>"Intel Corporation [8086]" → ("Intel Corporation", "8086")</summary>
    private static (string Name, string? Id) SplitId(string text)
    {
        var open = text.LastIndexOf(" [", StringComparison.Ordinal);
        return open > 0 && text.EndsWith(']') ? (text[..open], text[(open + 2)..^1]) : (text, null);
    }

    // Windows 장치 관리자와 같은 종류 이름
    private static string PciCategory(string code) =>
        code.StartsWith("01", StringComparison.Ordinal) ? "저장소 컨트롤러"
        : code.StartsWith("02", StringComparison.Ordinal) || code.StartsWith("0d", StringComparison.Ordinal) ? "네트워크 어댑터"
        : code.StartsWith("03", StringComparison.Ordinal) ? "디스플레이 어댑터"
        : code.StartsWith("04", StringComparison.Ordinal) ? "사운드, 비디오 및 게임 컨트롤러"
        : code == "0c03" ? "범용 직렬 버스 컨트롤러"
        : code is "0700" or "0701" ? "포트(COM & LPT)"
        : "시스템 장치";

    private static void AddUsb(List<DeviceEntry> items)
    {
        var entries = Entries("/sys/bus/usb/devices");
        foreach (var path in entries)
        {
            var name = Path.GetFileName(path);
            if (name.Contains(':') || name.StartsWith("usb", StringComparison.Ordinal))
                continue; // 인터페이스 · 루트 허브 (USB 컨트롤러는 PCI에 있다)
            var vendorId = ReadLine(path + "/idVendor");
            var productId = ReadLine(path + "/idProduct");
            // 인터페이스가 있는데 드라이버가 하나도 없으면 드라이버 없음
            var interfaces = entries.Where(e => Path.GetFileName(e).StartsWith(name + ":", StringComparison.Ordinal)).ToList();
            var problem = interfaces.Count > 0 && !interfaces.Any(i => Directory.Exists(i + "/driver")) ? 28 : 0;
            items.Add(new DeviceEntry(ReadLine(path + "/bDeviceClass") == "09" ? "범용 직렬 버스 컨트롤러" : "범용 직렬 버스 장치",
                ReadLine(path + "/product") ?? $"USB 장치 {vendorId}:{productId}", ReadLine(path + "/manufacturer"), problem,
                $"{vendorId}:{productId} ({name})"));
        }
    }

    private static void AddSerial(List<DeviceEntry> items)
    {
        foreach (var path in Entries("/sys/class/tty"))
        {
            var name = Path.GetFileName(path);
            var usb = name.StartsWith("ttyUSB", StringComparison.Ordinal) || name.StartsWith("ttyACM", StringComparison.Ordinal);
            // ttyS는 실제 UART만 (type 0 = 없음)
            if (!usb && !(name.StartsWith("ttyS", StringComparison.Ordinal) && ReadLine(path + "/type") is { } type && type != "0"))
                continue;
            var product = usb ? UsbProduct(path + "/device") : null;
            items.Add(new DeviceEntry("포트(COM & LPT)", product is null ? "/dev/" + name : $"{product} (/dev/{name})", null,
                Directory.Exists(path + "/device/driver") ? 0 : 28, name));
        }
    }

    /// <summary>tty 장치의 USB 부모(몇 단계 위)에 있는 제품 이름</summary>
    private static string? UsbProduct(string device)
    {
        try
        {
            var dir = new DirectoryInfo(device).ResolveLinkTarget(true)?.FullName ?? device;
            for (var i = 0; i < 4 && dir is not null; i++, dir = Path.GetDirectoryName(dir))
            {
                if (ReadLine(dir + "/product") is { } product)
                    return product;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 모름
        }
        return null;
    }

    private static void AddDisks(List<DeviceEntry> items)
    {
        foreach (var path in Entries("/sys/block"))
        {
            if (!Directory.Exists(path + "/device"))
                continue; // loop·ram·dm 같은 가상 장치
            var name = Path.GetFileName(path);
            var model = string.Join(" ", new[] { ReadLine(path + "/device/vendor"), ReadLine(path + "/device/model") }.Where(s => s is not null));
            items.Add(new DeviceEntry(name.StartsWith("sr", StringComparison.Ordinal) ? "DVD/CD-ROM 드라이브" : "디스크 드라이브",
                model.Length > 0 ? model : name, null, 0, "/dev/" + name));
        }
    }

    private static void AddInput(List<DeviceEntry> items)
    {
        string text;
        try
        {
            text = File.ReadAllText("/proc/bus/input/devices");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return;
        }
        foreach (var block in text.Split("\n\n", StringSplitOptions.RemoveEmptyEntries))
        {
            string? name = null, handlers = null, sysfs = null;
            foreach (var line in block.Split('\n'))
            {
                if (line.StartsWith("N: Name=", StringComparison.Ordinal))
                    name = line[8..].Trim('"');
                else if (line.StartsWith("H: Handlers=", StringComparison.Ordinal))
                    handlers = line[12..];
                else if (line.StartsWith("S: Sysfs=", StringComparison.Ordinal))
                    sysfs = line[9..];
            }
            if (string.IsNullOrEmpty(name))
                continue;
            var category = handlers?.Contains("mouse", StringComparison.Ordinal) == true ? "마우스 및 기타 포인팅 장치"
                : handlers?.Contains("kbd", StringComparison.Ordinal) == true && name.Contains("keyboard", StringComparison.OrdinalIgnoreCase) ? "키보드"
                : "휴먼 인터페이스 장치";
            items.Add(new DeviceEntry(category, name, null, 0, sysfs));
        }
    }

    private static string? ReadLine(string path)
    {
        try
        {
            return File.Exists(path) && File.ReadAllText(path).Trim() is { Length: > 0 } text ? text : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>폴더 안 항목 (sysfs는 대부분 폴더를 가리키는 링크라 파일·폴더 모두)</summary>
    private static List<string> Entries(string dir)
    {
        try
        {
            return Directory.EnumerateFileSystemEntries(dir).ToList();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    /// <summary>도구 실행 결과 (없거나 실패하면 null)</summary>
    private static string? Run(string file, string arguments)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo(file, arguments)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            });
            if (process is null)
                return null;
            var output = process.StandardOutput.ReadToEndAsync();
            _ = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(5000))
            {
                process.Kill(true);
                return null;
            }
            return process.ExitCode == 0 ? output.Result : null;
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
        {
            return null;
        }
    }

    private static long ClockTicks()
    {
        try
        {
            var ticks = sysconf(ScClkTck);
            return ticks > 0 ? ticks : 100;
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
        {
            return 100;
        }
    }

    private const int ScClkTck = 2;

    [DllImport("libc")]
    private static extern long sysconf(int name);

    [GeneratedRegex("\"([^\"]*)\"")]
    private static partial Regex QuotedRegex();
}
