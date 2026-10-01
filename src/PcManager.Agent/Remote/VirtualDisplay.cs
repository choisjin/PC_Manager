using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Microsoft.Win32;

namespace PcManager.Agent.Remote;

/// <summary>
/// 모니터가 없는(헤드리스) 테스트 PC용 가상 모니터. RDP가 자체 가상 디스플레이로 해상도를 맞추듯,
/// 원격조작을 시작할 때 물리 모니터가 없으면 가상 모니터를 켜고 대시보드 해상도에 맞춘다. 세션이 끝나면 끈다.
///
/// 드라이버: Virtual Display Driver (MIT, https://github.com/VirtualDrivers/Virtual-Display-Driver), IddCx 유저 모드 드라이버,
/// SignPath Foundation 정식 서명. 장치 생성/설치는 nefcon (MIT, https://github.com/nefarius/nefcon).
/// 두 파일 모두 에이전트 실행 파일에 내장돼 있고 처음 쓸 때 ProgramData 아래로 풀어 설치한다 (관리자/SYSTEM 필요).
/// </summary>
internal static class VirtualDisplay
{
    public const string HardwareId = @"Root\MttVDD";
    private const string InfName = "MttVDD.inf";
    private const string CatName = "mttvdd.cat";
    private const string SettingsName = "vdd_settings.xml";
    private const string RegistryKey = @"SOFTWARE\MikeTheTech\VirtualDisplayDriver";
    private static readonly Guid DisplayClassGuid = new("4d36e968-e325-11ce-bfc1-08002be10318");

    // 드라이버가 노출할 해상도 목록 (대시보드 PC 모니터와 같은 크기를 고를 수 있게 흔한 크기를 넉넉히)
    private static readonly (int W, int H)[] Resolutions =
    [
        (1024, 576), (1024, 768), (1152, 648), (1280, 720), (1280, 800), (1280, 1024), (1360, 768), (1366, 768),
        (1440, 810), (1440, 900), (1536, 864), (1600, 900), (1680, 945), (1680, 1050), (1760, 990), (1792, 1008),
        (1920, 1080), (1920, 1200), (2048, 1152), (2560, 1080), (2560, 1440), (2560, 1600), (3440, 1440), (3840, 2160),
    ];

    public static string Directory => Path.Combine(AgentOptions.DefaultDataDirectory, "vdd");

    /// <summary>
    /// 물리 모니터가 하나도 없는지. 가상 모니터 어댑터에 붙은 것과, 모니터가 없을 때 윈도우가 붙이는
    /// 자리표시 모니터(MONITOR\Default_Monitor, "Generic Non-PnP Monitor")는 세지 않는다.
    /// </summary>
    public static bool IsHeadless()
    {
        var adapter = new DISPLAY_DEVICE { cb = Marshal.SizeOf<DISPLAY_DEVICE>() };
        for (uint i = 0; EnumDisplayDevices(null, i, ref adapter, 0); i++)
        {
            if (IsVirtualAdapter(adapter))
                continue;
            var monitor = new DISPLAY_DEVICE { cb = Marshal.SizeOf<DISPLAY_DEVICE>() };
            for (uint j = 0; EnumDisplayDevices(adapter.DeviceName, j, ref monitor, 0); j++)
            {
                if ((monitor.StateFlags & DISPLAY_DEVICE_ACTIVE) == 0)
                    continue;
                if (monitor.DeviceID.Contains("Default_Monitor", StringComparison.OrdinalIgnoreCase))
                    continue;
                return false;
            }
        }
        return true;
    }

    /// <summary>가상 모니터 어댑터의 장치 이름(\\.\DISPLAYn). 없거나 꺼져 있으면 null</summary>
    public static string? FindAdapterDeviceName()
    {
        var adapter = new DISPLAY_DEVICE { cb = Marshal.SizeOf<DISPLAY_DEVICE>() };
        for (uint i = 0; EnumDisplayDevices(null, i, ref adapter, 0); i++)
        {
            if (IsVirtualAdapter(adapter) && (adapter.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP) != 0)
                return adapter.DeviceName;
        }
        return null;
    }

    private static bool IsVirtualAdapter(in DISPLAY_DEVICE adapter) =>
        adapter.DeviceString.Contains("Virtual Display", StringComparison.OrdinalIgnoreCase)
        || adapter.DeviceID.Contains("MttVDD", StringComparison.OrdinalIgnoreCase);

    /// <summary>드라이버(장치 노드)가 설치돼 있는지</summary>
    public static bool IsInstalled() => FindDevice(out _, out _);

    /// <summary>
    /// 모니터가 없는 PC면 가상 모니터를 준비한다: 설치(최초) → 켜기 → 데스크톱에 붙을 때까지 대기 → 주 모니터로.
    /// 한 번 켠 가상 모니터는 끄지 않는다 (헤드리스 테스트 PC는 항상 화면이 있어야 썸네일·GUI 테스트가 된다).
    /// </summary>
    /// <returns>가상 모니터 어댑터 이름. 모니터가 있는 PC면 null</returns>
    public static string? EnsureForHeadless(Action<string>? log = null)
    {
        if (!IsHeadless())
            return null;
        EnsureInstalled(log);
        if (!IsEnabled())
            SetEnabled(true);
        string? device = null;
        for (var i = 0; i < 40 && (device = FindAdapterDeviceName()) is null; i++)
            Thread.Sleep(250);
        if (device is null)
            throw new InvalidOperationException("가상 모니터가 켜지지 않았습니다.");
        if (!DisplayModes.TrySetPrimary(device))
            log?.Invoke("가상 모니터를 주 모니터로 만들지 못했습니다");
        return device;
    }

    /// <summary>내장 파일을 풀고 드라이버를 설치한다. 이미 설치돼 있으면 설정만 갱신한다</summary>
    public static void EnsureInstalled(Action<string>? log = null)
    {
        System.IO.Directory.CreateDirectory(Directory);
        ExtractResources();
        WriteSettings();
        // 드라이버가 설정 파일을 찾는 위치
        using (var key = Registry.LocalMachine.CreateSubKey(RegistryKey))
            key.SetValue("VDDPATH", Directory, RegistryValueKind.String);

        if (IsInstalled())
            return;

        // 서명자를 신뢰 게시자에 넣어야 설치 확인 창 없이 무인 설치된다
        TrustPublisher(Path.Combine(Directory, CatName));

        log?.Invoke("가상 모니터 드라이버 설치");
        var output = RunNefcon("install", Path.Combine(Directory, InfName), HardwareId);
        if (!IsInstalled())
            throw new InvalidOperationException($"가상 모니터 드라이버 설치 실패: {output}");
    }

    /// <summary>가상 모니터를 켜거나 끈다 (장치 사용/사용 안 함)</summary>
    public static void SetEnabled(bool enabled)
    {
        if (!FindDevice(out var set, out var data))
            throw new InvalidOperationException("가상 모니터 드라이버가 설치돼 있지 않습니다.");
        try
        {
            var change = new SP_PROPCHANGE_PARAMS
            {
                ClassInstallHeader = new SP_CLASSINSTALL_HEADER { cbSize = Marshal.SizeOf<SP_CLASSINSTALL_HEADER>(), InstallFunction = DIF_PROPERTYCHANGE },
                StateChange = enabled ? DICS_ENABLE : DICS_DISABLE,
                Scope = DICS_FLAG_GLOBAL,
                HwProfile = 0,
            };
            if (!SetupDiSetClassInstallParams(set, ref data, ref change, Marshal.SizeOf<SP_PROPCHANGE_PARAMS>()))
                throw new Win32Exception();
            if (!SetupDiCallClassInstaller(DIF_PROPERTYCHANGE, set, ref data))
                throw new Win32Exception();
        }
        finally
        {
            SetupDiDestroyDeviceInfoList(set);
        }
    }

    public static bool IsEnabled()
    {
        if (!FindDevice(out var set, out var data))
            return false;
        try
        {
            return CM_Get_DevNode_Status(out var status, out _, data.DevInst, 0) == 0 && (status & DN_STARTED) != 0;
        }
        finally
        {
            SetupDiDestroyDeviceInfoList(set);
        }
    }

    /// <summary>장치 노드와 드라이버 패키지를 제거한다 (에이전트 제거 시)</summary>
    public static void Uninstall(Action<string>? log = null)
    {
        if (!IsInstalled())
            return;
        log?.Invoke("가상 모니터 드라이버 제거");
        var inf = Path.Combine(Directory, InfName);
        if (!File.Exists(inf))
            ExtractResources();
        RunNefcon("--remove-device-node", "--hardware-id", HardwareId, "--class-guid", DisplayClassGuid.ToString("B"));
        RunNefcon("--uninstall-driver", "--inf-path", inf);
        try
        {
            Registry.LocalMachine.DeleteSubKeyTree(RegistryKey, throwOnMissingSubKey: false);
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
        {
            // 무시
        }
    }

    private static void ExtractResources()
    {
        var assembly = Assembly.GetExecutingAssembly();
        foreach (var name in assembly.GetManifestResourceNames().Where(n => n.StartsWith("vdd/", StringComparison.Ordinal)))
        {
            var target = Path.Combine(Directory, name["vdd/".Length..]);
            using var stream = assembly.GetManifestResourceStream(name)!;
            if (File.Exists(target) && new FileInfo(target).Length == stream.Length)
                continue;
            using var file = File.Create(target);
            stream.CopyTo(file);
        }
    }

    private static void WriteSettings()
    {
        var sb = new StringBuilder();
        sb.AppendLine("<?xml version='1.0' encoding='utf-8'?>");
        sb.AppendLine("<vdd_settings>");
        sb.AppendLine("  <monitors><count>1</count></monitors>");
        sb.AppendLine("  <gpu><friendlyname>default</friendlyname></gpu>");
        sb.AppendLine("  <global><g_refresh_rate>60</g_refresh_rate></global>");
        sb.AppendLine("  <resolutions>");
        foreach (var (w, h) in Resolutions)
            sb.AppendLine($"    <resolution><width>{w}</width><height>{h}</height><refresh_rate>60</refresh_rate></resolution>");
        sb.AppendLine("  </resolutions>");
        sb.AppendLine("  <options>");
        sb.AppendLine("    <CustomEdid>false</CustomEdid><PreventSpoof>false</PreventSpoof><EdidCeaOverride>false</EdidCeaOverride>");
        sb.AppendLine("    <HardwareCursor>true</HardwareCursor><SDR10bit>false</SDR10bit><HDRPlus>false</HDRPlus>");
        sb.AppendLine("    <logging>false</logging><debuglogging>false</debuglogging>");
        sb.AppendLine("  </options>");
        sb.AppendLine("</vdd_settings>");
        File.WriteAllText(Path.Combine(Directory, SettingsName), sb.ToString(), new UTF8Encoding(false));
    }

    private static void TrustPublisher(string catalogPath)
    {
        var certs = new X509Certificate2Collection();
        certs.Import(File.ReadAllBytes(catalogPath));
        using var store = new X509Store(StoreName.TrustedPublisher, StoreLocation.LocalMachine);
        store.Open(OpenFlags.ReadWrite);
        foreach (var cert in certs)
        {
            // 서명자(말단)만 넣는다. 중간·루트(GlobalSign)는 이미 신뢰된다
            if (cert.Subject == cert.Issuer || cert.Extensions["2.5.29.19"] is X509BasicConstraintsExtension { CertificateAuthority: true })
                continue;
            if (store.Certificates.Find(X509FindType.FindByThumbprint, cert.Thumbprint, false).Count == 0)
                store.Add(cert);
        }
    }

    private static string RunNefcon(params string[] args)
    {
        var start = new ProcessStartInfo(Path.Combine(Directory, "nefconc.exe"))
        {
            WorkingDirectory = Directory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var a in args)
            start.ArgumentList.Add(a);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("nefconc를 실행하지 못했습니다.");
        var output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
        process.WaitForExit(60_000);
        return output.Trim();
    }

    /// <summary>하드웨어 ID로 장치를 찾는다. 찾으면 호출자가 set을 SetupDiDestroyDeviceInfoList로 닫아야 한다</summary>
    private static bool FindDevice(out IntPtr set, out SP_DEVINFO_DATA data)
    {
        data = new SP_DEVINFO_DATA { cbSize = Marshal.SizeOf<SP_DEVINFO_DATA>() };
        var guid = DisplayClassGuid;
        set = SetupDiGetClassDevs(ref guid, null, IntPtr.Zero, DIGCF_PRESENT);
        if (set == INVALID_HANDLE_VALUE)
            return false;

        var buffer = new byte[4096];
        for (var i = 0; SetupDiEnumDeviceInfo(set, i, ref data); i++)
        {
            if (!SetupDiGetDeviceRegistryProperty(set, ref data, SPDRP_HARDWAREID, out _, buffer, buffer.Length, out var size))
                continue;
            var ids = Encoding.Unicode.GetString(buffer, 0, size).Split('\0', StringSplitOptions.RemoveEmptyEntries);
            if (ids.Any(id => id.Equals(HardwareId, StringComparison.OrdinalIgnoreCase)))
                return true;
        }
        SetupDiDestroyDeviceInfoList(set);
        set = IntPtr.Zero;
        return false;
    }

    private const int DISPLAY_DEVICE_ACTIVE = 0x1;
    private const int DISPLAY_DEVICE_ATTACHED_TO_DESKTOP = 0x1;
    private const int DIGCF_PRESENT = 0x2;
    private const int SPDRP_HARDWAREID = 0x1;
    private const int DIF_PROPERTYCHANGE = 0x12;
    private const int DICS_ENABLE = 1;
    private const int DICS_DISABLE = 2;
    private const int DICS_FLAG_GLOBAL = 1;
    private const int DN_STARTED = 0x8;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DISPLAY_DEVICE
    {
        public int cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
        public int StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SP_DEVINFO_DATA
    {
        public int cbSize;
        public Guid ClassGuid;
        public int DevInst;
        public IntPtr Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SP_CLASSINSTALL_HEADER
    {
        public int cbSize;
        public int InstallFunction;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SP_PROPCHANGE_PARAMS
    {
        public SP_CLASSINSTALL_HEADER ClassInstallHeader;
        public int StateChange;
        public int Scope;
        public int HwProfile;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool EnumDisplayDevices(string? device, uint index, ref DISPLAY_DEVICE displayDevice, uint flags);

    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr SetupDiGetClassDevs(ref Guid classGuid, string? enumerator, IntPtr parent, int flags);

    [DllImport("setupapi.dll", SetLastError = true)]
    private static extern bool SetupDiEnumDeviceInfo(IntPtr set, int index, ref SP_DEVINFO_DATA data);

    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SetupDiGetDeviceRegistryProperty(IntPtr set, ref SP_DEVINFO_DATA data, int property, out int regType, byte[] buffer, int bufferSize, out int requiredSize);

    [DllImport("setupapi.dll", SetLastError = true)]
    private static extern bool SetupDiSetClassInstallParams(IntPtr set, ref SP_DEVINFO_DATA data, ref SP_PROPCHANGE_PARAMS parameters, int size);

    [DllImport("setupapi.dll", SetLastError = true)]
    private static extern bool SetupDiCallClassInstaller(int installFunction, IntPtr set, ref SP_DEVINFO_DATA data);

    [DllImport("setupapi.dll", SetLastError = true)]
    private static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);

    [DllImport("cfgmgr32.dll")]
    private static extern int CM_Get_DevNode_Status(out int status, out int problem, int devInst, int flags);
}
