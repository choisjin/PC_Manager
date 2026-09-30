using System.Drawing;
using System.Runtime.InteropServices;

namespace PcManager.Agent.Remote;

/// <summary>
/// 브라우저에서 받은 마우스/키보드 이벤트를 SendInput으로 넣는다.
/// 키는 KeyboardEvent.code(물리 키 위치)를 스캔 코드로 바꿔 보내므로, 원격 PC의 키보드 배열/IME가 그대로 적용된다.
/// </summary>
internal static class InputInjector
{
    /// <param name="nx">모니터 안의 상대 위치 0~1</param>
    public static void MoveMouse(Rectangle monitor, double nx, double ny)
    {
        var (ax, ay) = ToAbsolute(monitor, nx, ny);
        Send(MouseInput(ax, ay, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK));
    }

    /// <param name="button">0=왼쪽, 1=가운데, 2=오른쪽, 3=뒤로, 4=앞으로 (PointerEvent.button)</param>
    public static void MouseButton(Rectangle monitor, double nx, double ny, int button, bool down)
    {
        var (ax, ay) = ToAbsolute(monitor, nx, ny);
        var (flag, data) = button switch
        {
            0 => (down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP, 0),
            1 => (down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP, 0),
            2 => (down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP, 0),
            3 => (down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP, XBUTTON1),
            4 => (down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP, XBUTTON2),
            _ => (0u, 0),
        };
        if (flag == 0)
            return;
        Send(MouseInput(ax, ay, data, flag | MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK));
    }

    /// <param name="deltaY">위로 굴리면 양수 (한 칸 = 120)</param>
    public static void Wheel(int deltaX, int deltaY)
    {
        if (deltaY != 0)
            Send(MouseInput(0, 0, deltaY, MOUSEEVENTF_WHEEL));
        if (deltaX != 0)
            Send(MouseInput(0, 0, deltaX, MOUSEEVENTF_HWHEEL));
    }

    /// <summary>브라우저가 알려주는 조합 키(수식 키) 상태</summary>
    public readonly record struct Modifiers(bool Shift, bool Ctrl, bool Alt, bool Meta)
    {
        public static readonly Modifiers None = default;
    }

    // 우리가 원격에서 누르고 있다고 보는 수식 키 상태 (Shift/Ctrl/Alt/Win)
    // 브라우저의 keydown/keyup이 유실되거나 순서가 어긋나도, 실제 키를 넣기 직전에 맞춰 준다
    private static readonly bool[] ModHeld = new bool[4];
    private const int ModShift = 0, ModCtrl = 1, ModAlt = 2, ModWin = 3;
    private static readonly int[] ModScan = [0x2A, 0x1D, 0x38, 0xE05B];

    private static readonly HashSet<string> ModifierCodes =
    [
        "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
        "AltLeft", "AltRight", "MetaLeft", "MetaRight",
    ];

    /// <param name="code">KeyboardEvent.code (예: KeyA, ArrowLeft)</param>
    /// <param name="key">KeyboardEvent.key. 한/영, 한자 키 구분에 쓴다</param>
    /// <param name="mods">이 이벤트 시점의 브라우저 수식 키 상태. 유실된 수식 키를 보정하는 데 쓴다</param>
    public static void Key(string code, string? key, bool down, Modifiers mods = default)
    {
        // 한국어 키보드의 한/영·한자 키 등은 가상 키로 보낸다
        var vk = key switch
        {
            "HangulMode" or "KanaMode" => VK_HANGUL,
            "HanjaMode" => VK_HANJA,
            _ => code switch
            {
                "Lang1" => VK_HANGUL,
                "Lang2" => VK_HANJA,
                "Pause" => VK_PAUSE,
                "NumLock" => VK_NUMLOCK,
                _ => (ushort)0,
            },
        };
        if (vk != 0)
        {
            Send(KeyInput(vk, 0, down ? 0 : KEYEVENTF_KEYUP));
            return;
        }

        if (!ScanCodes.TryGetValue(code, out var scan))
            return;

        var isModifier = ModifierCodes.Contains(code);
        if (isModifier)
        {
            SendScan(scan, down);
            UpdateHeld(code, down);
            return;
        }

        // 일반 키를 누르기 직전, 원격의 수식 키를 브라우저 상태와 일치시킨다
        // (Shift+숫자처럼 수식 키 keydown이 유실돼도 여기서 Shift를 눌러 준다)
        if (down)
            ReconcileModifiers(mods);
        SendScan(scan, down);
    }

    /// <summary>Win, Ctrl+Esc처럼 브라우저가 가로채는 조합을 원격에서 누른다</summary>
    public static void Combo(IReadOnlyList<string> codes)
    {
        // 조합에 포함된 수식 키를 미리 반영해, 일반 키를 누를 때 방금 누른 수식 키가 풀리지 않게 한다
        var mods = new Modifiers(
            codes.Any(c => c is "ShiftLeft" or "ShiftRight"),
            codes.Any(c => c is "ControlLeft" or "ControlRight"),
            codes.Any(c => c is "AltLeft" or "AltRight"),
            codes.Any(c => c is "MetaLeft" or "MetaRight"));
        foreach (var code in codes)
            Key(code, null, true, mods);
        for (var i = codes.Count - 1; i >= 0; i--)
            Key(codes[i], null, false, mods);
    }

    /// <summary>원격에서 눌린 것으로 관리하던 수식 키를 모두 뗀다 (브라우저 포커스 이탈 시)</summary>
    public static void ReleaseModifiers()
    {
        for (var slot = 0; slot < ModHeld.Length; slot++)
        {
            if (!ModHeld[slot])
                continue;
            SendScan(ModScan[slot], false);
            ModHeld[slot] = false;
        }
    }

    private static void ReconcileModifiers(Modifiers mods)
    {
        Set(ModShift, mods.Shift);
        Set(ModCtrl, mods.Ctrl);
        Set(ModAlt, mods.Alt);
        Set(ModWin, mods.Meta);

        static void Set(int slot, bool wanted)
        {
            if (ModHeld[slot] == wanted)
                return;
            SendScan(ModScan[slot], wanted);
            ModHeld[slot] = wanted;
        }
    }

    private static void UpdateHeld(string code, bool down)
    {
        var slot = code switch
        {
            "ShiftLeft" or "ShiftRight" => ModShift,
            "ControlLeft" or "ControlRight" => ModCtrl,
            "AltLeft" or "AltRight" => ModAlt,
            "MetaLeft" or "MetaRight" => ModWin,
            _ => -1,
        };
        if (slot >= 0)
            ModHeld[slot] = down;
    }

    private static void SendScan(int scan, bool down)
    {
        var flags = KEYEVENTF_SCANCODE | (down ? 0 : KEYEVENTF_KEYUP);
        if (scan > 0xFF)
            flags |= KEYEVENTF_EXTENDEDKEY;
        Send(KeyInput(0, (ushort)(scan & 0xFF), flags));
    }

    /// <summary>문자열을 유니코드 키 입력으로 보낸다 (붙여넣기용)</summary>
    public static void Text(string text)
    {
        foreach (var ch in text.Replace("\r\n", "\n"))
        {
            if (ch == '\n')
            {
                Key("Enter", null, true);
                Key("Enter", null, false);
                continue;
            }
            Send(KeyInput(0, ch, KEYEVENTF_UNICODE));
            Send(KeyInput(0, ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
    }

    public static Point CursorPosition() => GetCursorPos(out var p) ? new Point(p.X, p.Y) : Point.Empty;

    private static (int X, int Y) ToAbsolute(Rectangle monitor, double nx, double ny)
    {
        var x = monitor.Left + Math.Clamp(nx, 0, 1) * (monitor.Width - 1);
        var y = monitor.Top + Math.Clamp(ny, 0, 1) * (monitor.Height - 1);
        // MOUSEEVENTF_VIRTUALDESK: 가상 데스크톱 전체를 0~65535로 정규화
        var vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        var vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        var vw = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN) - 1);
        var vh = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN) - 1);
        return ((int)Math.Round((x - vx) * 65535.0 / vw), (int)Math.Round((y - vy) * 65535.0 / vh));
    }

    private static INPUT MouseInput(int x, int y, int data, uint flags) => new()
    {
        type = INPUT_MOUSE,
        u = new InputUnion { mi = new MOUSEINPUT { dx = x, dy = y, mouseData = data, dwFlags = flags } },
    };

    private static INPUT KeyInput(ushort vk, ushort scan, uint flags) => new()
    {
        type = INPUT_KEYBOARD,
        u = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags } },
    };

    private static void Send(INPUT input)
    {
        Span<INPUT> inputs = [input];
        SendInput(1, ref inputs[0], Marshal.SizeOf<INPUT>());
    }

    // KeyboardEvent.code → 스캔 코드 세트 1 (0xE0xx는 확장 키)
    private static readonly Dictionary<string, int> ScanCodes = BuildScanCodes();

    private static Dictionary<string, int> BuildScanCodes()
    {
        var map = new Dictionary<string, int>
        {
            ["Escape"] = 0x01, ["Minus"] = 0x0C, ["Equal"] = 0x0D, ["Backspace"] = 0x0E, ["Tab"] = 0x0F,
            ["BracketLeft"] = 0x1A, ["BracketRight"] = 0x1B, ["Enter"] = 0x1C, ["ControlLeft"] = 0x1D,
            ["Semicolon"] = 0x27, ["Quote"] = 0x28, ["Backquote"] = 0x29, ["ShiftLeft"] = 0x2A, ["Backslash"] = 0x2B,
            ["Comma"] = 0x33, ["Period"] = 0x34, ["Slash"] = 0x35, ["ShiftRight"] = 0x36, ["NumpadMultiply"] = 0x37,
            ["AltLeft"] = 0x38, ["Space"] = 0x39, ["CapsLock"] = 0x3A, ["ScrollLock"] = 0x46,
            ["Numpad7"] = 0x47, ["Numpad8"] = 0x48, ["Numpad9"] = 0x49, ["NumpadSubtract"] = 0x4A,
            ["Numpad4"] = 0x4B, ["Numpad5"] = 0x4C, ["Numpad6"] = 0x4D, ["NumpadAdd"] = 0x4E,
            ["Numpad1"] = 0x4F, ["Numpad2"] = 0x50, ["Numpad3"] = 0x51, ["Numpad0"] = 0x52, ["NumpadDecimal"] = 0x53,
            ["IntlBackslash"] = 0x56, ["F11"] = 0x57, ["F12"] = 0x58, ["IntlRo"] = 0x73, ["IntlYen"] = 0x7D,
            ["NumpadEnter"] = 0xE01C, ["ControlRight"] = 0xE01D, ["NumpadDivide"] = 0xE035, ["PrintScreen"] = 0xE037,
            ["AltRight"] = 0xE038, ["Home"] = 0xE047, ["ArrowUp"] = 0xE048, ["PageUp"] = 0xE049,
            ["ArrowLeft"] = 0xE04B, ["ArrowRight"] = 0xE04D, ["End"] = 0xE04F, ["ArrowDown"] = 0xE050,
            ["PageDown"] = 0xE051, ["Insert"] = 0xE052, ["Delete"] = 0xE053,
            ["MetaLeft"] = 0xE05B, ["MetaRight"] = 0xE05C, ["ContextMenu"] = 0xE05D,
        };

        // 숫자 1~9, 0
        for (var i = 1; i <= 9; i++)
            map[$"Digit{i}"] = 0x01 + i;
        map["Digit0"] = 0x0B;

        // F1~F10
        for (var i = 1; i <= 10; i++)
            map[$"F{i}"] = 0x3A + i;

        // 알파벳 (QWERTY 물리 위치)
        const string rows = "QWERTYUIOP|ASDFGHJKL|ZXCVBNM";
        int[] rowStart = [0x10, 0x1E, 0x2C];
        var parts = rows.Split('|');
        for (var r = 0; r < parts.Length; r++)
        {
            for (var c = 0; c < parts[r].Length; c++)
                map[$"Key{parts[r][c]}"] = rowStart[r] + c;
        }
        return map;
    }

    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;

    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_XDOWN = 0x0080;
    private const uint MOUSEEVENTF_XUP = 0x0100;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x1000;
    private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    private const int XBUTTON1 = 1;
    private const int XBUTTON2 = 2;

    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint KEYEVENTF_SCANCODE = 0x0008;

    private const ushort VK_PAUSE = 0x13;
    private const ushort VK_HANGUL = 0x15;
    private const ushort VK_HANJA = 0x19;
    private const ushort VK_NUMLOCK = 0x90;

    private const int SM_XVIRTUALSCREEN = 76;
    private const int SM_YVIRTUALSCREEN = 77;
    private const int SM_CXVIRTUALSCREEN = 78;
    private const int SM_CYVIRTUALSCREEN = 79;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion u;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public int mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, ref INPUT inputs, int size);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT point);
}

/// <summary>
/// 현재 스레드를 입력 데스크톱(Default ↔ Winlogon: UAC 확인 창, 잠금/로그인 화면)으로 옮긴다.
/// SYSTEM 권한일 때만 Winlogon 데스크톱에 접근할 수 있다. 창이나 훅이 없는 스레드에서만 동작한다.
/// </summary>
internal static class DesktopSwitcher
{
    [ThreadStatic]
    private static IntPtr _current;

    [ThreadStatic]
    private static string? _currentName;

    /// <returns>데스크톱이 바뀌었으면 true (캡처 장치를 다시 만들어야 함)</returns>
    public static bool SyncThreadToInputDesktop()
    {
        var desktop = OpenInputDesktop(0, false, GENERIC_ALL);
        if (desktop == IntPtr.Zero)
            return false;

        var name = GetName(desktop);
        if (name == _currentName || !SetThreadDesktop(desktop))
        {
            CloseDesktop(desktop);
            return false;
        }

        var previous = _current;
        _current = desktop;
        _currentName = name;
        if (previous != IntPtr.Zero)
            CloseDesktop(previous);
        return true;
    }

    public static string? CurrentName => _currentName;

    private static string? GetName(IntPtr desktop)
    {
        var buffer = new char[256];
        return GetUserObjectInformation(desktop, UOI_NAME, buffer, buffer.Length * 2, out var needed)
            ? new string(buffer, 0, Math.Max(0, needed / 2 - 1))
            : null;
    }

    private const uint GENERIC_ALL = 0x10000000;
    private const int UOI_NAME = 2;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetThreadDesktop(IntPtr desktop);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr desktop);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool GetUserObjectInformation(IntPtr obj, int index, [Out] char[] info, int length, out int needed);
}
