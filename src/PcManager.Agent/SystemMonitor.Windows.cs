using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;
using PcManager.Agent.Service;
using PcManager.Shared;

namespace PcManager.Agent;

// Windows: 레지스트리 · Win32 API · 성능 카운터(PDH) · SetupAPI로 읽는다 (WMI는 느리고 망가진 PC가 있어 쓰지 않는다)
public sealed partial class SystemMonitor
{
    private static readonly Guid DisplayClass = new("4d36e968-e325-11ce-bfc1-08002be10318");

    private byte[] _processBuffer = new byte[512 * 1024];

    private partial PcSystemInfo ReadSystemInfo()
    {
        using var nt = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
        var build = Text(nt, "CurrentBuild") ?? Environment.OSVersion.Version.Build.ToString(CultureInfo.InvariantCulture);
        var product = Text(nt, "ProductName") ?? "Windows";
        // Windows 11도 ProductName은 "Windows 10 …"이다 (빌드 22000부터 11)
        if (int.TryParse(build, out var number) && number >= 22000 && product.StartsWith("Windows 10", StringComparison.Ordinal))
            product = "Windows 11" + product["Windows 10".Length..];
        if (nt?.GetValue("UBR") is int ubr)
            build += "." + ubr.ToString(CultureInfo.InvariantCulture);

        using var bios = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\BIOS");
        var (maker, model) = Board(Text(bios, "SystemManufacturer"), Text(bios, "SystemProductName"),
            Text(bios, "BaseBoardManufacturer"), Text(bios, "BaseBoardProduct"));
        using var cpu = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\CentralProcessor\0");

        return new PcSystemInfo("windows", Environment.MachineName, product, Text(nt, "DisplayVersion") ?? Text(nt, "ReleaseId"), build,
            Architecture(), maker, model, Join(Text(bios, "BIOSVersion"), Text(bios, "BIOSReleaseDate")),
            Text(cpu, "ProcessorNameString") ?? "", PhysicalCores(), Environment.ProcessorCount, InstalledMemory(),
            DeviceNames(DisplayClass), DateTime.UtcNow - TimeSpan.FromMilliseconds(Environment.TickCount64), LoggedOnUsers(), ReadDrives());
    }

    private static string? Text(RegistryKey? key, string name) =>
        key?.GetValue(name) is string s && s.Trim() is { Length: > 0 } t ? t : null;

    private static long InstalledMemory()
    {
        if (GetPhysicallyInstalledSystemMemory(out var kb) && kb > 0)
            return (long)kb * 1024;
        return (long)MemoryStatus().ullTotalPhys;
    }

    private static int PhysicalCores()
    {
        var length = 0;
        GetLogicalProcessorInformationEx(RelationProcessorCore, IntPtr.Zero, ref length);
        if (length <= 0)
            return 0;
        var buffer = Marshal.AllocHGlobal(length);
        try
        {
            if (!GetLogicalProcessorInformationEx(RelationProcessorCore, buffer, ref length))
                return 0;
            // 코어 관계만 물었으므로 항목 하나 = 코어 하나 (항목 크기는 4바이트 위치)
            var cores = 0;
            for (var offset = 0; offset < length; cores++)
            {
                var size = Marshal.ReadInt32(buffer, offset + 4);
                if (size <= 0)
                    break;
                offset += size;
            }
            return cores;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /// <summary>로그인한 사용자 (화면·원격 데스크톱, 연결이 끊긴 세션 포함)</summary>
    private static List<string> LoggedOnUsers()
    {
        try
        {
            return SessionProcess.GetActiveSessionIds().Concat(SessionProcess.GetDisconnectedUserSessionIds())
                .Select(SessionProcess.GetUserName).Where(n => n.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        }
        catch (Win32Exception)
        {
            return [];
        }
    }

    private partial List<RawProcess> ReadProcesses()
    {
        if (IntPtr.Size != 8)
            throw new PlatformNotSupportedException("64비트 Windows만 프로세스 목록을 읽습니다");
        while (true)
        {
            var buffer = _processBuffer;
            int status, needed;
            unsafe
            {
                fixed (byte* p = buffer)
                {
                    status = NtQuerySystemInformation(SystemProcessInformation, p, buffer.Length, out needed);
                    if (status == 0)
                        return ParseProcesses(p);
                }
            }
            if (status != StatusInfoLengthMismatch)
                throw new Win32Exception($"NtQuerySystemInformation 실패 (0x{status:X8})");
            // 그 사이 프로세스가 늘 수 있어 여유를 둔다
            _processBuffer = new byte[Math.Max(needed, buffer.Length) + 128 * 1024];
        }
    }

    /// <summary>SYSTEM_PROCESS_INFORMATION (x64) 목록. 프로세스마다 열지 않아 보호된 프로세스도 CPU 시간을 읽는다</summary>
    private static unsafe List<RawProcess> ParseProcesses(byte* p)
    {
        var list = new List<RawProcess>(512);
        for (var entry = p; ; )
        {
            var id = (int)*(long*)(entry + 80); // UniqueProcessId
            if (id != 0) // System Idle Process
            {
                var nameBytes = *(ushort*)(entry + 56); // ImageName.Length
                var nameBuffer = *(IntPtr*)(entry + 64); // ImageName.Buffer
                var name = nameBytes > 0 && nameBuffer != IntPtr.Zero
                    ? new string((char*)nameBuffer, 0, nameBytes / 2)
                    : id == 4 ? "System" : id.ToString(CultureInfo.InvariantCulture);
                // CreateTime 32 · UserTime 40 · KernelTime 48 · WorkingSetPrivateSize 8
                list.Add(new RawProcess(id, name, *(long*)(entry + 32), *(long*)(entry + 40) + *(long*)(entry + 48), *(long*)(entry + 8)));
            }
            var next = *(uint*)entry; // NextEntryOffset
            if (next == 0)
                return list;
            entry += next;
        }
    }

    private partial IPerfReader OpenPerf() => new WindowsPerf();

    private sealed class WindowsPerf : IPerfReader
    {
        private readonly Pdh? _disk = Pdh.TryOpen(
            @"\PhysicalDisk(_Total)\Disk Read Bytes/sec", @"\PhysicalDisk(_Total)\Disk Write Bytes/sec", @"\PhysicalDisk(*)\% Idle Time");
        // 엔진(3D·복사·비디오 …)마다 프로세스별 사용률 → 엔진별로 더해 가장 바쁜 엔진 (작업 관리자의 GPU)
        private readonly Pdh? _gpu = Pdh.TryOpen(@"\GPU Engine(*)\Utilization Percentage");
        private readonly NetworkRate _network = new();
        private (long Idle, long Total) _cpu = CpuTimes();

        public WindowsPerf() => _network.Read(0);

        public PerfSample Read(double seconds)
        {
            var cpu = CpuTimes();
            var usage = cpu.Total > _cpu.Total ? 100.0 * (1 - (double)(cpu.Idle - _cpu.Idle) / (cpu.Total - _cpu.Total)) : 0;
            _cpu = cpu;
            var memory = MemoryStatus();

            double read = 0, write = 0, active = 0;
            if (_disk?.Collect() == true)
            {
                read = Math.Round(_disk.Value(0));
                write = Math.Round(_disk.Value(1));
                var idle = _disk.Values(2).Where(v => v.Name != "_Total").Select(v => v.Value).DefaultIfEmpty(100).Min();
                active = 100 - idle;
            }
            double? gpu = _gpu?.Collect() == true ? GpuBusy(_gpu.Values(0)) : null;
            var (receive, send) = _network.Read(seconds);
            return new PerfSample(0, Percent(usage), (long)(memory.ullTotalPhys - memory.ullAvailPhys), (long)memory.ullTotalPhys,
                read, write, Percent(active), receive, send, gpu);
        }

        /// <summary>인스턴스 이름 "pid_1234_luid_0x…_phys_0_eng_3_engtype_3D" → pid를 뺀 엔진별 합의 최댓값</summary>
        private static double GpuBusy(List<(string Name, double Value)> values)
        {
            var engines = new Dictionary<string, double>();
            foreach (var (name, value) in values)
            {
                var luid = name.IndexOf("luid_", StringComparison.Ordinal);
                var key = luid >= 0 ? name[luid..] : name;
                engines[key] = engines.GetValueOrDefault(key) + value;
            }
            return Percent(engines.Count > 0 ? engines.Values.Max() : 0);
        }

        public void Dispose()
        {
            _disk?.Dispose();
            _gpu?.Dispose();
        }
    }

    private static (long Idle, long Total) CpuTimes()
    {
        // 커널 시간에 유휴 시간이 들어 있다
        return GetSystemTimes(out var idle, out var kernel, out var user) ? (idle, kernel + user) : (0, 0);
    }

    private static MEMORYSTATUSEX MemoryStatus()
    {
        var status = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
        GlobalMemoryStatusEx(ref status);
        return status;
    }

    /// <summary>성능 카운터 질의 하나 (영어 카운터 이름이라 한국어 Windows에서도 같다). 못 연 카운터는 0·빈 목록</summary>
    private sealed class Pdh : IDisposable
    {
        private readonly IntPtr _query;
        private readonly IntPtr[] _counters;

        private Pdh(IntPtr query, IntPtr[] counters)
        {
            _query = query;
            _counters = counters;
        }

        public static Pdh? TryOpen(params string[] paths)
        {
            if (PdhOpenQuery(null, IntPtr.Zero, out var query) != 0)
                return null;
            var counters = paths.Select(path => PdhAddEnglishCounter(query, path, IntPtr.Zero, out var c) == 0 ? c : IntPtr.Zero).ToArray();
            if (counters.All(c => c == IntPtr.Zero))
            {
                PdhCloseQuery(query);
                return null;
            }
            // 초당 값은 두 번 읽어야 나온다
            PdhCollectQueryData(query);
            return new Pdh(query, counters);
        }

        public bool Collect() => PdhCollectQueryData(_query) == 0;

        public double Value(int index) =>
            _counters[index] != IntPtr.Zero && PdhGetFormattedCounterValue(_counters[index], PdhFmtDouble, out _, out var v) == 0 && v.CStatus <= 1
                ? v.Double
                : 0;

        public List<(string Name, double Value)> Values(int index)
        {
            var result = new List<(string, double)>();
            var counter = _counters[index];
            if (counter == IntPtr.Zero)
                return result;
            // 그 사이 인스턴스가 늘면 크기가 모자랄 수 있어 몇 번 다시 묻는다
            for (var attempt = 0; attempt < 3; attempt++)
            {
                uint size = 0;
                if (PdhGetFormattedCounterArray(counter, PdhFmtDouble, ref size, out _, IntPtr.Zero) != PdhMoreData)
                    return result;
                var buffer = Marshal.AllocHGlobal((int)size);
                try
                {
                    var status = PdhGetFormattedCounterArray(counter, PdhFmtDouble, ref size, out var count, buffer);
                    if (status == PdhMoreData)
                        continue;
                    if (status != 0)
                        return result;
                    // PDH_FMT_COUNTERVALUE_ITEM_W = { LPWSTR szName; PDH_FMT_COUNTERVALUE FmtValue(CStatus 4 + 맞춤 4 + double 8) }
                    var itemSize = IntPtr.Size + 16;
                    for (var i = 0; i < count; i++)
                    {
                        var item = buffer + i * itemSize;
                        if ((uint)Marshal.ReadInt32(item, IntPtr.Size) > 1)
                            continue; // 값이 없는 인스턴스 (PDH_CSTATUS_VALID_DATA·NEW_DATA만)
                        var name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(item)) ?? "";
                        result.Add((name, BitConverter.Int64BitsToDouble(Marshal.ReadInt64(item, IntPtr.Size + 8))));
                    }
                    return result;
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }
            return result;
        }

        public void Dispose() => PdhCloseQuery(_query);
    }

    private partial DeviceList ReadDevices()
    {
        var buffer = new byte[2048];
        var chars = new char[512];
        var classes = new Dictionary<Guid, string?>();
        var items = new List<DeviceEntry>();
        foreach (var (set, found) in Devices(null))
        {
            var data = found;
            // 장치 관리자가 숨기는 장치 (숨긴 장치 표시를 켜야 보이는 것)
            if (CM_Get_DevNode_Status(out var status, out var problem, data.DevInst, 0) != 0 || (status & DN_NO_SHOW_IN_DM) != 0)
                continue;
            if (!classes.TryGetValue(data.ClassGuid, out var className))
                classes[data.ClassGuid] = className = ClassName(data.ClassGuid, chars);
            if (className is null)
                continue;
            var name = Property(set, ref data, SPDRP_FRIENDLYNAME, buffer) ?? Property(set, ref data, SPDRP_DEVICEDESC, buffer) ?? "알 수 없는 장치";
            items.Add(new DeviceEntry(className, name, Property(set, ref data, SPDRP_MFG, buffer),
                (status & DN_HAS_PROBLEM) != 0 ? problem : 0, InstanceId(set, ref data, chars)));
        }
        return new DeviceList(items);
    }

    /// <summary>장치 종류 이름 (Windows 표시 언어). 장치 관리자에 안 나오는 종류(NoDisplayClass)면 null</summary>
    private static string? ClassName(Guid guid, char[] chars)
    {
        if (guid == Guid.Empty)
            return "기타 장치";
        using (var key = Registry.LocalMachine.OpenSubKey($@"SYSTEM\CurrentControlSet\Control\Class\{guid:B}"))
        {
            if (key?.GetValue("NoDisplayClass") is not null)
                return null;
        }
        return SetupDiGetClassDescription(ref guid, chars, chars.Length, out var length) && length > 1
            ? new string(chars, 0, length - 1)
            : guid.ToString("B");
    }

    private static List<string> DeviceNames(Guid classGuid)
    {
        var buffer = new byte[2048];
        var names = new List<string>();
        foreach (var (set, found) in Devices(classGuid))
        {
            var data = found;
            if ((Property(set, ref data, SPDRP_FRIENDLYNAME, buffer) ?? Property(set, ref data, SPDRP_DEVICEDESC, buffer)) is { } name)
                names.Add(name);
        }
        return names;
    }

    /// <summary>지금 연결된 장치 (classGuid가 null이면 모든 종류)</summary>
    private static IEnumerable<(IntPtr Set, SP_DEVINFO_DATA Data)> Devices(Guid? classGuid)
    {
        var guid = classGuid ?? Guid.Empty;
        var set = classGuid is null
            ? SetupDiGetClassDevs(IntPtr.Zero, null, IntPtr.Zero, DIGCF_PRESENT | DIGCF_ALLCLASSES)
            : SetupDiGetClassDevs(ref guid, null, IntPtr.Zero, DIGCF_PRESENT);
        if (set == InvalidHandle)
            yield break;
        try
        {
            var data = new SP_DEVINFO_DATA { cbSize = Marshal.SizeOf<SP_DEVINFO_DATA>() };
            for (var i = 0; SetupDiEnumDeviceInfo(set, i, ref data); i++)
                yield return (set, data);
        }
        finally
        {
            SetupDiDestroyDeviceInfoList(set);
        }
    }

    private static string? Property(IntPtr set, ref SP_DEVINFO_DATA data, int property, byte[] buffer)
    {
        if (!SetupDiGetDeviceRegistryProperty(set, ref data, property, out _, buffer, buffer.Length, out var size) || size < 2)
            return null;
        var text = Encoding.Unicode.GetString(buffer, 0, Math.Min(size, buffer.Length)).TrimEnd('\0').Trim();
        // "@oem12.inf,%desc%;이름" 형식이면 이름만
        if (text.StartsWith('@') && text.LastIndexOf(';') is var semi and >= 0)
            text = text[(semi + 1)..].Trim();
        return text.Length > 0 ? text : null;
    }

    private static string? InstanceId(IntPtr set, ref SP_DEVINFO_DATA data, char[] chars) =>
        SetupDiGetDeviceInstanceId(set, ref data, chars, chars.Length, out var length) && length > 1 ? new string(chars, 0, length - 1) : null;

    private const int SystemProcessInformation = 5;
    private const int StatusInfoLengthMismatch = unchecked((int)0xC0000004);
    private const int RelationProcessorCore = 0;
    private const uint PdhFmtDouble = 0x200;
    private const int PdhMoreData = unchecked((int)0x800007D2);
    private const int DIGCF_PRESENT = 0x2;
    private const int DIGCF_ALLCLASSES = 0x4;
    private const int SPDRP_DEVICEDESC = 0x0;
    private const int SPDRP_MFG = 0xB;
    private const int SPDRP_FRIENDLYNAME = 0xC;
    private const int DN_HAS_PROBLEM = 0x400;
    private const int DN_NO_SHOW_IN_DM = 0x40000000;
    private static readonly IntPtr InvalidHandle = new(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct PDH_FMT_COUNTERVALUE
    {
        [FieldOffset(0)] public uint CStatus;
        [FieldOffset(8)] public double Double;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SP_DEVINFO_DATA
    {
        public int cbSize;
        public Guid ClassGuid;
        public int DevInst;
        public IntPtr Reserved;
    }

    [DllImport("ntdll.dll")]
    private static extern unsafe int NtQuerySystemInformation(int infoClass, byte* buffer, int length, out int returnLength);

    [DllImport("kernel32.dll")]
    private static extern bool GetSystemTimes(out long idle, out long kernel, out long user);

    [DllImport("kernel32.dll")]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX status);

    [DllImport("kernel32.dll")]
    private static extern bool GetPhysicallyInstalledSystemMemory(out ulong kilobytes);

    [DllImport("kernel32.dll")]
    private static extern bool GetLogicalProcessorInformationEx(int relationship, IntPtr buffer, ref int length);

    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    private static extern int PdhOpenQuery(string? dataSource, IntPtr userData, out IntPtr query);

    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    private static extern int PdhAddEnglishCounter(IntPtr query, string path, IntPtr userData, out IntPtr counter);

    [DllImport("pdh.dll")]
    private static extern int PdhCollectQueryData(IntPtr query);

    [DllImport("pdh.dll")]
    private static extern int PdhGetFormattedCounterValue(IntPtr counter, uint format, out uint type, out PDH_FMT_COUNTERVALUE value);

    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    private static extern int PdhGetFormattedCounterArray(IntPtr counter, uint format, ref uint bufferSize, out uint itemCount, IntPtr buffer);

    [DllImport("pdh.dll")]
    private static extern int PdhCloseQuery(IntPtr query);

    [DllImport("setupapi.dll", EntryPoint = "SetupDiGetClassDevsW", CharSet = CharSet.Unicode)]
    private static extern IntPtr SetupDiGetClassDevs(IntPtr classGuid, string? enumerator, IntPtr parent, int flags);

    [DllImport("setupapi.dll", EntryPoint = "SetupDiGetClassDevsW", CharSet = CharSet.Unicode)]
    private static extern IntPtr SetupDiGetClassDevs(ref Guid classGuid, string? enumerator, IntPtr parent, int flags);

    [DllImport("setupapi.dll")]
    private static extern bool SetupDiEnumDeviceInfo(IntPtr set, int index, ref SP_DEVINFO_DATA data);

    [DllImport("setupapi.dll", EntryPoint = "SetupDiGetDeviceRegistryPropertyW", CharSet = CharSet.Unicode)]
    private static extern bool SetupDiGetDeviceRegistryProperty(IntPtr set, ref SP_DEVINFO_DATA data, int property, out int regType,
        [Out] byte[] buffer, int bufferSize, out int requiredSize);

    [DllImport("setupapi.dll", EntryPoint = "SetupDiGetDeviceInstanceIdW", CharSet = CharSet.Unicode)]
    private static extern bool SetupDiGetDeviceInstanceId(IntPtr set, ref SP_DEVINFO_DATA data, [Out] char[] buffer, int bufferSize, out int requiredSize);

    [DllImport("setupapi.dll", EntryPoint = "SetupDiGetClassDescriptionW", CharSet = CharSet.Unicode)]
    private static extern bool SetupDiGetClassDescription(ref Guid classGuid, [Out] char[] buffer, int bufferSize, out int requiredSize);

    [DllImport("setupapi.dll")]
    private static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);

    [DllImport("cfgmgr32.dll")]
    private static extern int CM_Get_DevNode_Status(out int status, out int problem, int devInst, int flags);
}
