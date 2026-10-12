using System.Drawing;
using System.Runtime.InteropServices;

namespace PcManager.Agent.Remote;

/// <summary>
/// 원격조작 중 모니터 구성(토폴로지). 모니터가 여러 대인 PC는 원격조작하는 동안 고른 모니터 하나만 켜서
/// (RDP 단일 모니터처럼) 창이 보이지 않는 모니터로 열리지 않게 하고, 끝나면 원래 구성으로 되돌린다.
/// 바꾼 구성은 디스플레이 데이터베이스에 저장하지 않는다(임시). 원격조작 프로세스가 강제로 끝나 되돌리지 못했으면
/// 다음 원격조작을 시작할 때 표시 파일을 보고 저장된 구성으로 되돌린다.
/// </summary>
internal static class DisplayTopology
{
    /// <summary>원래 구성의 모니터 하나 (GDI 장치 이름, 주 모니터 여부, 원래 데스크톱 좌표)</summary>
    public readonly record struct Monitor(string DeviceName, bool Primary, Rectangle Bounds, uint AdapterLow, int AdapterHigh, uint SourceId);

    private static readonly Lock Gate = new();
    private static DISPLAYCONFIG_PATH_INFO[]? _originalPaths;
    private static DISPLAYCONFIG_MODE_INFO[]? _originalModes;

    // 구성을 바꾼 채 프로세스가 끝났는지 알기 위한 표시 파일
    private static string MarkerPath => Path.Combine(AgentOptions.DefaultDataDirectory, "display-single-monitor.flag");

    /// <summary>
    /// 지금 구성을 기억한다. 모니터(원본)가 2개 이상이면 그 목록을, 아니면 null (바꿀 필요 없음).
    /// 이전 원격조작이 되돌리지 못하고 끝났으면 먼저 저장된 구성으로 되돌린다.
    /// </summary>
    public static List<Monitor>? Remember()
    {
        lock (Gate)
        {
            if (File.Exists(MarkerPath))
            {
                SetDisplayConfig(0, null, 0, null, SDC_APPLY | SDC_USE_DATABASE_CURRENT);
                TryDeleteMarker();
            }

            if (!TryQuery(out var paths, out var modes))
                return null;
            var monitors = new List<Monitor>();
            foreach (var path in paths)
            {
                var source = path.sourceInfo;
                if (monitors.Any(m => SameSource(m, source)))
                    continue; // 복제(같은 화면) 모니터는 하나로
                if (source.modeInfoIdx >= modes.Length)
                    continue;
                var mode = modes[source.modeInfoIdx];
                var name = SourceName(source);
                if (name is null)
                    continue;
                var bounds = new Rectangle(mode.positionX, mode.positionY, (int)mode.width, (int)mode.height);
                monitors.Add(new Monitor(name, bounds.X == 0 && bounds.Y == 0, bounds, source.adapterLow, source.adapterHigh, source.id));
            }
            if (monitors.Count < 2)
                return null;
            _originalPaths = paths;
            _originalModes = modes;
            return monitors;
        }
    }

    /// <summary>기억한 구성에서 이 모니터 하나만 켜고 주 모니터(0,0)로 만든다</summary>
    /// <returns>오류 메시지. 성공하면 null</returns>
    public static string? UseOnly(Monitor monitor)
    {
        lock (Gate)
        {
            if (_originalPaths is null || _originalModes is not { } originalModes)
                return "원래 모니터 구성을 기억하지 못했습니다.";

            var paths = new List<DISPLAYCONFIG_PATH_INFO>();
            var modes = new List<DISPLAYCONFIG_MODE_INFO>();
            var remap = new Dictionary<uint, uint>();
            uint Remap(uint index, bool source)
            {
                if (index == DISPLAYCONFIG_PATH_MODE_IDX_INVALID || index >= originalModes.Length)
                    return DISPLAYCONFIG_PATH_MODE_IDX_INVALID;
                if (remap.TryGetValue(index, out var mapped))
                    return mapped;
                var mode = originalModes[index];
                if (source && mode.infoType == DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE)
                {
                    mode.positionX = 0;
                    mode.positionY = 0;
                }
                modes.Add(mode);
                return remap[index] = (uint)(modes.Count - 1);
            }

            foreach (var original in _originalPaths)
            {
                if (!SameSource(monitor, original.sourceInfo))
                    continue;
                var path = original;
                path.flags |= DISPLAYCONFIG_PATH_ACTIVE;
                path.sourceInfo.modeInfoIdx = Remap(original.sourceInfo.modeInfoIdx, true);
                path.targetInfo.modeInfoIdx = Remap(original.targetInfo.modeInfoIdx, false);
                paths.Add(path);
            }
            if (paths.Count == 0)
                return "모니터를 찾지 못했습니다.";

            WriteMarker();
            var rc = SetDisplayConfig((uint)paths.Count, [.. paths], (uint)modes.Count, [.. modes],
                SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_ALLOW_CHANGES);
            return rc == 0 ? null : $"모니터 구성을 바꾸지 못했습니다 (코드 {rc})";
        }
    }

    /// <summary>원래 구성으로 되돌린다 (원격조작 종료 시). 바꾼 적이 없으면 아무것도 하지 않는다</summary>
    public static void Restore()
    {
        lock (Gate)
        {
            if (_originalPaths is null || _originalModes is null)
                return;
            if (!File.Exists(MarkerPath))
            {
                _originalPaths = null;
                _originalModes = null;
                return;
            }
            var rc = SetDisplayConfig((uint)_originalPaths.Length, _originalPaths, (uint)_originalModes.Length, _originalModes,
                SDC_APPLY | SDC_USE_SUPPLIED_DISPLAY_CONFIG | SDC_ALLOW_CHANGES);
            // 그대로 되돌리지 못하면(그사이 모니터를 뺀 경우 등) 저장된 구성으로
            if (rc != 0)
                SetDisplayConfig(0, null, 0, null, SDC_APPLY | SDC_USE_DATABASE_CURRENT);
            _originalPaths = null;
            _originalModes = null;
            TryDeleteMarker();
        }
    }

    private static bool SameSource(Monitor monitor, DISPLAYCONFIG_PATH_SOURCE_INFO source) =>
        monitor.AdapterLow == source.adapterLow && monitor.AdapterHigh == source.adapterHigh && monitor.SourceId == source.id;

    private static bool TryQuery(out DISPLAYCONFIG_PATH_INFO[] paths, out DISPLAYCONFIG_MODE_INFO[] modes)
    {
        paths = [];
        modes = [];
        for (var attempt = 0; attempt < 3; attempt++)
        {
            if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out var pathCount, out var modeCount) != 0)
                return false;
            paths = new DISPLAYCONFIG_PATH_INFO[pathCount];
            modes = new DISPLAYCONFIG_MODE_INFO[modeCount];
            var rc = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref pathCount, paths, ref modeCount, modes, IntPtr.Zero);
            if (rc == ERROR_INSUFFICIENT_BUFFER)
                continue; // 그사이 구성이 바뀜
            if (rc != 0)
                return false;
            Array.Resize(ref paths, (int)pathCount);
            Array.Resize(ref modes, (int)modeCount);
            return true;
        }
        return false;
    }

    private static string? SourceName(DISPLAYCONFIG_PATH_SOURCE_INFO source)
    {
        var request = new DISPLAYCONFIG_SOURCE_DEVICE_NAME
        {
            type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
            size = (uint)Marshal.SizeOf<DISPLAYCONFIG_SOURCE_DEVICE_NAME>(),
            adapterLow = source.adapterLow,
            adapterHigh = source.adapterHigh,
            id = source.id,
        };
        return DisplayConfigGetDeviceInfo(ref request) == 0 ? request.viewGdiDeviceName : null;
    }

    private static void WriteMarker()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(MarkerPath)!);
            File.WriteAllText(MarkerPath, DateTime.Now.ToString("O"));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 표시 파일이 없어도 정상 종료 때는 되돌린다
        }
    }

    private static void TryDeleteMarker()
    {
        try
        {
            File.Delete(MarkerPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // 무시
        }
    }

    private const uint QDC_ONLY_ACTIVE_PATHS = 0x2;
    private const uint SDC_USE_DATABASE_CURRENT = 0xF;
    private const uint SDC_USE_SUPPLIED_DISPLAY_CONFIG = 0x20;
    private const uint SDC_APPLY = 0x80;
    private const uint SDC_ALLOW_CHANGES = 0x400;
    private const uint DISPLAYCONFIG_PATH_ACTIVE = 0x1;
    private const uint DISPLAYCONFIG_PATH_MODE_IDX_INVALID = 0xFFFFFFFF;
    private const int DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME = 1;
    private const int DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE = 1;
    private const int ERROR_INSUFFICIENT_BUFFER = 122;

    [StructLayout(LayoutKind.Sequential)]
    private struct DISPLAYCONFIG_PATH_SOURCE_INFO
    {
        public uint adapterLow;
        public int adapterHigh;
        public uint id;
        public uint modeInfoIdx;
        public uint statusFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DISPLAYCONFIG_PATH_TARGET_INFO
    {
        public uint adapterLow;
        public int adapterHigh;
        public uint id;
        public uint modeInfoIdx;
        public int outputTechnology;
        public int rotation;
        public int scaling;
        public uint refreshNumerator;
        public uint refreshDenominator;
        public int scanLineOrdering;
        public int targetAvailable;
        public uint statusFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DISPLAYCONFIG_PATH_INFO
    {
        public DISPLAYCONFIG_PATH_SOURCE_INFO sourceInfo;
        public DISPLAYCONFIG_PATH_TARGET_INFO targetInfo;
        public uint flags;
    }

    /// <summary>모드 하나 (64바이트). 원본 모드일 때만 크기·위치를 쓰고 나머지(대상 모드 신호 정보)는 그대로 둔다</summary>
    [StructLayout(LayoutKind.Explicit, Size = 64)]
    private struct DISPLAYCONFIG_MODE_INFO
    {
        [FieldOffset(0)] public int infoType;
        [FieldOffset(4)] public uint id;
        [FieldOffset(8)] public uint adapterLow;
        [FieldOffset(12)] public int adapterHigh;
        [FieldOffset(16)] public uint width;
        [FieldOffset(20)] public uint height;
        [FieldOffset(24)] public int pixelFormat;
        [FieldOffset(28)] public int positionX;
        [FieldOffset(32)] public int positionY;
        [FieldOffset(56)] private readonly long _tail; // 대상 모드 신호 정보 끝까지 크기 맞춤
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DISPLAYCONFIG_SOURCE_DEVICE_NAME
    {
        public int type;
        public uint size;
        public uint adapterLow;
        public int adapterHigh;
        public uint id;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string viewGdiDeviceName;
    }

    [DllImport("user32.dll")]
    private static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPathArrayElements, out uint numModeInfoArrayElements);

    [DllImport("user32.dll")]
    private static extern int QueryDisplayConfig(uint flags, ref uint numPathArrayElements, [Out] DISPLAYCONFIG_PATH_INFO[] pathArray,
        ref uint numModeInfoArrayElements, [Out] DISPLAYCONFIG_MODE_INFO[] modeInfoArray, IntPtr currentTopologyId);

    [DllImport("user32.dll")]
    private static extern int SetDisplayConfig(uint numPathArrayElements, DISPLAYCONFIG_PATH_INFO[]? pathArray,
        uint numModeInfoArrayElements, DISPLAYCONFIG_MODE_INFO[]? modeInfoArray, uint flags);

    [DllImport("user32.dll")]
    private static extern int DisplayConfigGetDeviceInfo(ref DISPLAYCONFIG_SOURCE_DEVICE_NAME requestPacket);
}
