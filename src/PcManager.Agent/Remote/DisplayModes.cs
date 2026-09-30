using System.Collections.Concurrent;
using System.Drawing;
using System.Runtime.InteropServices;

namespace PcManager.Agent.Remote;

/// <summary>모니터 하나 (장치 이름, 주 모니터 여부, 현재 데스크톱 좌표)</summary>
internal readonly record struct DisplayInfo(string DeviceName, bool Primary, Rectangle Bounds);

/// <summary>
/// 원격 PC의 디스플레이 모드(해상도) 조회·변경. RDP처럼 보는 쪽 PC 해상도에 맞추기 위해 쓴다.
/// WinForms Screen은 메시지 루프가 없는 프로세스에서 값이 갱신되지 않으므로 Win32로 직접 읽는다.
/// 바꾼 모드는 레지스트리에 남기지 않으며(임시), 세션이 끝나면 RestoreAll로 되돌린다.
/// </summary>
internal static class DisplayModes
{
    // 장치별 원래 모드 (되돌리기용)
    private static readonly ConcurrentDictionary<string, DEVMODE> Originals = new();

    public static List<DisplayInfo> Enumerate()
    {
        var result = new List<DisplayInfo>();
        var device = new DISPLAY_DEVICE { cb = Marshal.SizeOf<DISPLAY_DEVICE>() };
        for (uint i = 0; EnumDisplayDevices(null, i, ref device, 0); i++)
        {
            if ((device.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP) == 0)
                continue;
            if (!TryGetCurrentMode(device.DeviceName, out var mode))
                continue;
            var primary = (device.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE) != 0;
            result.Add(new DisplayInfo(device.DeviceName, primary,
                new Rectangle(mode.dmPositionX, mode.dmPositionY, mode.dmPelsWidth, mode.dmPelsHeight)));
        }
        return result;
    }

    /// <summary>
    /// 보는 쪽 화면 크기에 가장 잘 맞는 지원 모드로 바꾼다. 같은 크기가 있으면 그것, 없으면 화면비가 같은 것 중 가장 큰 것,
    /// 그것도 없으면 가로세로 모두 작은 것 중 가장 큰 것. 이미 그 모드면 아무것도 하지 않는다.
    /// </summary>
    /// <returns>모드를 바꿨거나 이미 맞으면 true. 지원 모드가 없거나 실패하면 false</returns>
    public static bool TryMatch(string deviceName, int wantWidth, int wantHeight, out Size applied, out string? error)
    {
        applied = default;
        error = null;
        if (!TryGetCurrentMode(deviceName, out var current))
        {
            error = "현재 디스플레이 모드를 읽지 못했습니다.";
            return false;
        }

        var candidates = new List<DEVMODE>();
        var mode = new DEVMODE { dmSize = (short)Marshal.SizeOf<DEVMODE>() };
        for (var i = 0; EnumDisplaySettingsEx(deviceName, i, ref mode, 0); i++)
        {
            if (mode.dmBitsPerPel != 32 || mode.dmPelsWidth > wantWidth || mode.dmPelsHeight > wantHeight)
                continue;
            candidates.Add(mode);
        }
        if (candidates.Count == 0)
        {
            error = $"{wantWidth}×{wantHeight} 이하의 지원 모드가 없습니다.";
            return false;
        }

        var wantRatio = (double)wantWidth / wantHeight;
        var best = candidates
            .OrderByDescending(m => m.dmPelsWidth == wantWidth && m.dmPelsHeight == wantHeight)
            .ThenByDescending(m => Math.Abs((double)m.dmPelsWidth / m.dmPelsHeight - wantRatio) < 0.02)
            .ThenByDescending(m => (long)m.dmPelsWidth * m.dmPelsHeight)
            // 같은 해상도면 현재 주사율과 같은 것을 우선
            .ThenByDescending(m => m.dmDisplayFrequency == current.dmDisplayFrequency)
            .ThenByDescending(m => m.dmDisplayFrequency)
            .First();

        applied = new Size(best.dmPelsWidth, best.dmPelsHeight);
        if (best.dmPelsWidth == current.dmPelsWidth && best.dmPelsHeight == current.dmPelsHeight)
            return true;

        Originals.TryAdd(deviceName, current);
        best.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_BITSPERPEL | DM_DISPLAYFREQUENCY;
        var rc = ChangeDisplaySettingsEx(deviceName, ref best, IntPtr.Zero, 0, IntPtr.Zero);
        if (rc != DISP_CHANGE_SUCCESSFUL)
        {
            error = $"디스플레이 모드 변경 실패 (코드 {rc})";
            return false;
        }
        return true;
    }

    /// <summary>
    /// 지정한 모니터를 주 모니터(0,0)로 만든다. 다른 모니터는 상대 위치를 유지한 채 옮긴다.
    /// 헤드리스 PC에서 가상 모니터를 켰을 때 창들이 거기에 열리게 하기 위한 것.
    /// </summary>
    public static bool TrySetPrimary(string deviceName)
    {
        if (!TryGetCurrentMode(deviceName, out var target))
            return false;
        var dx = -target.dmPositionX;
        var dy = -target.dmPositionY;
        if (dx == 0 && dy == 0)
            return true;

        foreach (var display in Enumerate())
        {
            if (!TryGetCurrentMode(display.DeviceName, out var mode))
                continue;
            mode.dmPositionX += dx;
            mode.dmPositionY += dy;
            mode.dmFields = DM_POSITION;
            var flags = CDS_UPDATEREGISTRY | CDS_NORESET | (display.DeviceName == deviceName ? CDS_SET_PRIMARY : 0);
            if (ChangeDisplaySettingsEx(display.DeviceName, ref mode, IntPtr.Zero, (uint)flags, IntPtr.Zero) != DISP_CHANGE_SUCCESSFUL)
                return false;
        }
        // 모아 둔 변경을 한 번에 적용
        return ChangeDisplaySettingsEx(null, IntPtr.Zero, IntPtr.Zero, 0, IntPtr.Zero) == DISP_CHANGE_SUCCESSFUL;
    }

    /// <summary>바꿨던 모든 모니터를 원래 모드로 되돌린다 (세션 종료 시)</summary>
    public static void RestoreAll()
    {
        foreach (var (device, original) in Originals)
        {
            var mode = original;
            mode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT | DM_BITSPERPEL | DM_DISPLAYFREQUENCY;
            ChangeDisplaySettingsEx(device, ref mode, IntPtr.Zero, 0, IntPtr.Zero);
        }
        Originals.Clear();
    }

    /// <summary>모니터가 지원하는 32bpp 모드 목록 (진단용)</summary>
    public static List<(int Width, int Height, int Frequency)> ListModes(string deviceName)
    {
        var result = new List<(int, int, int)>();
        var mode = new DEVMODE { dmSize = (short)Marshal.SizeOf<DEVMODE>() };
        for (var i = 0; EnumDisplaySettingsEx(deviceName, i, ref mode, 0); i++)
        {
            if (mode.dmBitsPerPel == 32)
                result.Add((mode.dmPelsWidth, mode.dmPelsHeight, mode.dmDisplayFrequency));
        }
        return result;
    }

    private static bool TryGetCurrentMode(string deviceName, out DEVMODE mode)
    {
        mode = new DEVMODE { dmSize = (short)Marshal.SizeOf<DEVMODE>() };
        return EnumDisplaySettingsEx(deviceName, ENUM_CURRENT_SETTINGS, ref mode, 0);
    }

    private const int ENUM_CURRENT_SETTINGS = -1;
    private const int DISPLAY_DEVICE_ATTACHED_TO_DESKTOP = 0x1;
    private const int DISPLAY_DEVICE_PRIMARY_DEVICE = 0x4;
    private const int DM_POSITION = 0x20;
    private const int DM_BITSPERPEL = 0x40000;
    private const int CDS_UPDATEREGISTRY = 0x1;
    private const int CDS_NORESET = 0x10000000;
    private const int CDS_SET_PRIMARY = 0x10;
    private const int DM_PELSWIDTH = 0x80000;
    private const int DM_PELSHEIGHT = 0x100000;
    private const int DM_DISPLAYFREQUENCY = 0x400000;
    private const int DISP_CHANGE_SUCCESSFUL = 0;

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

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DEVMODE
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion;
        public short dmDriverVersion;
        public short dmSize;
        public short dmDriverExtra;
        public int dmFields;
        public int dmPositionX;
        public int dmPositionY;
        public int dmDisplayOrientation;
        public int dmDisplayFixedOutput;
        public short dmColor;
        public short dmDuplex;
        public short dmYResolution;
        public short dmTTOption;
        public short dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel;
        public int dmPelsWidth;
        public int dmPelsHeight;
        public int dmDisplayFlags;
        public int dmDisplayFrequency;
        public int dmICMMethod;
        public int dmICMIntent;
        public int dmMediaType;
        public int dmDitherType;
        public int dmReserved1;
        public int dmReserved2;
        public int dmPanningWidth;
        public int dmPanningHeight;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool EnumDisplayDevices(string? device, uint index, ref DISPLAY_DEVICE displayDevice, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool EnumDisplaySettingsEx(string deviceName, int modeIndex, ref DEVMODE devMode, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int ChangeDisplaySettingsEx(string deviceName, ref DEVMODE devMode, IntPtr hwnd, uint flags, IntPtr param);

    // devMode = NULL: 모아 둔(CDS_NORESET) 변경을 적용
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int ChangeDisplaySettingsEx(string? deviceName, IntPtr devMode, IntPtr hwnd, uint flags, IntPtr param);
}
