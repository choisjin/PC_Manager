using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace PcManager.Agent.Linux.Remote;

/// <summary>libX11 / libXtst 호출 (입력 주입·커서 위치·화면 크기)</summary>
internal static partial class X11
{
    private const string LibX11 = "libX11.so.6";
    private const string LibXtst = "libXtst.so.6";

    [LibraryImport(LibX11, StringMarshalling = StringMarshalling.Utf8)]
    public static partial IntPtr XOpenDisplay(string? name);

    [LibraryImport(LibX11)]
    public static partial int XCloseDisplay(IntPtr display);

    [LibraryImport(LibX11)]
    public static partial IntPtr XDefaultRootWindow(IntPtr display);

    [LibraryImport(LibX11)]
    public static partial int XDisplayWidth(IntPtr display, int screen);

    [LibraryImport(LibX11)]
    public static partial int XDisplayHeight(IntPtr display, int screen);

    [LibraryImport(LibX11)]
    public static partial int XFlush(IntPtr display);

    [LibraryImport(LibX11)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool XQueryPointer(IntPtr display, IntPtr window, out IntPtr root, out IntPtr child,
        out int rootX, out int rootY, out int winX, out int winY, out uint mask);

    [LibraryImport(LibXtst)]
    public static partial int XTestFakeMotionEvent(IntPtr display, int screen, int x, int y, ulong delay);

    [LibraryImport(LibXtst)]
    public static partial int XTestFakeButtonEvent(IntPtr display, uint button, [MarshalAs(UnmanagedType.Bool)] bool isPress, ulong delay);

    [LibraryImport(LibXtst)]
    public static partial int XTestFakeKeyEvent(IntPtr display, uint keycode, [MarshalAs(UnmanagedType.Bool)] bool isPress, ulong delay);
}

/// <summary>모니터 (전체 X 화면 좌표)</summary>
public record Monitor(int Index, string Name, bool Primary, int X, int Y, int Width, int Height);

internal static partial class Monitors
{
    /// <summary>xrandr --listmonitors 로 모니터 목록. 없으면 X 화면 전체를 모니터 하나로</summary>
    public static List<Monitor> List()
    {
        var list = new List<Monitor>();
        try
        {
            using var process = Process.Start(new ProcessStartInfo("xrandr", "--listmonitors")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            });
            if (process is not null)
            {
                var output = process.StandardOutput.ReadToEnd();
                process.WaitForExit(3000);
                // " 0: +*HDMI-1 1920/509x1080/286+0+0  HDMI-1"
                foreach (Match m in MonitorLine().Matches(output))
                {
                    list.Add(new Monitor(list.Count, m.Groups["name"].Value, m.Groups["flags"].Value.Contains('*'),
                        int.Parse(m.Groups["x"].Value), int.Parse(m.Groups["y"].Value),
                        int.Parse(m.Groups["w"].Value), int.Parse(m.Groups["h"].Value)));
                }
            }
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // xrandr 없음 → 아래 기본값
        }

        if (list.Count == 0)
        {
            var display = X11.XOpenDisplay(null);
            if (display != IntPtr.Zero)
            {
                list.Add(new Monitor(0, "screen", true, 0, 0, X11.XDisplayWidth(display, 0), X11.XDisplayHeight(display, 0)));
                X11.XCloseDisplay(display);
            }
        }
        if (list.Count > 0 && !list.Any(m => m.Primary))
            list[0] = list[0] with { Primary = true };
        return list;
    }

    [GeneratedRegex(@"^\s*\d+:\s+(?<flags>[+*]*)(?<name>\S+)\s+(?<w>\d+)/\d+x(?<h>\d+)/\d+\+(?<x>-?\d+)\+(?<y>-?\d+)", RegexOptions.Multiline)]
    private static partial Regex MonitorLine();
}

/// <summary>
/// 브라우저 입력 → XTest. 좌표는 현재 모니터 기준 0~1, 키는 KeyboardEvent.code (물리 키).
/// X 키코드 = Linux evdev 키코드 + 8 (표준 evdev 키맵)
/// </summary>
internal sealed class InputInjector : IDisposable
{
    private readonly IntPtr _display;
    private readonly HashSet<string> _held = [];
    private int _wheelX;
    private int _wheelY;

    public InputInjector()
    {
        _display = X11.XOpenDisplay(null);
        if (_display == IntPtr.Zero)
            throw new InvalidOperationException("X 화면에 연결하지 못했습니다 (DISPLAY/XAUTHORITY 확인).");
    }

    public void Move(Monitor monitor, double x, double y)
    {
        var px = monitor.X + (int)Math.Round(Math.Clamp(x, 0, 1) * (monitor.Width - 1));
        var py = monitor.Y + (int)Math.Round(Math.Clamp(y, 0, 1) * (monitor.Height - 1));
        X11.XTestFakeMotionEvent(_display, -1, px, py, 0);
        X11.XFlush(_display);
    }

    /// <param name="button">PointerEvent.button (0 왼쪽, 1 가운데, 2 오른쪽, 3 뒤로, 4 앞으로)</param>
    public void Button(int button, bool down)
    {
        uint xButton = button switch { 0 => 1, 1 => 2, 2 => 3, 3 => 8, 4 => 9, _ => 0 };
        if (xButton == 0)
            return;
        X11.XTestFakeButtonEvent(_display, xButton, down, 0);
        X11.XFlush(_display);
    }

    /// <param name="dx">WHEEL_DELTA 단위(120 = 한 칸), 양수 = 오른쪽</param>
    /// <param name="dy">양수 = 위로</param>
    public void Wheel(int dx, int dy)
    {
        _wheelY += dy;
        _wheelX += dx;
        while (Math.Abs(_wheelY) >= 120)
        {
            Click(_wheelY > 0 ? 4u : 5u);
            _wheelY -= Math.Sign(_wheelY) * 120;
        }
        while (Math.Abs(_wheelX) >= 120)
        {
            Click(_wheelX > 0 ? 7u : 6u);
            _wheelX -= Math.Sign(_wheelX) * 120;
        }
        X11.XFlush(_display);
    }

    private void Click(uint button)
    {
        X11.XTestFakeButtonEvent(_display, button, true, 0);
        X11.XTestFakeButtonEvent(_display, button, false, 0);
    }

    public void Key(string code, bool down, bool shift, bool ctrl, bool alt, bool meta)
    {
        if (!Evdev.TryGetValue(code, out var evdev))
            return;
        var isModifier = ModifierGroup(code) is not null;
        // 브라우저 포커스가 바뀌는 동안 놓친 수정 키를 맞춘다 (일반 키를 누를 때만)
        if (down && !isModifier)
            Reconcile(shift, ctrl, alt, meta);
        SendKey(code, evdev, down);
        X11.XFlush(_display);
    }

    /// <summary>조합 키: 순서대로 누르고 반대로 뗀다 (예: AltLeft, Tab)</summary>
    public void Combo(IReadOnlyList<string> codes)
    {
        var pressed = new List<(string Code, int Evdev)>();
        foreach (var code in codes)
        {
            if (Evdev.TryGetValue(code, out var evdev))
            {
                SendKey(code, evdev, true);
                pressed.Add((code, evdev));
            }
        }
        for (var i = pressed.Count - 1; i >= 0; i--)
            SendKey(pressed[i].Code, pressed[i].Evdev, false);
        X11.XFlush(_display);
    }

    /// <summary>눌린 채 남은 수정 키를 모두 뗀다</summary>
    public void Reset()
    {
        foreach (var code in _held.ToList())
            SendKey(code, Evdev[code], false);
        X11.XFlush(_display);
    }

    private void SendKey(string code, int evdev, bool down)
    {
        X11.XTestFakeKeyEvent(_display, (uint)(evdev + 8), down, 0);
        if (ModifierGroup(code) is null)
            return;
        if (down)
            _held.Add(code);
        else
            _held.Remove(code);
    }

    private void Reconcile(bool shift, bool ctrl, bool alt, bool meta)
    {
        foreach (var (group, wanted) in new[] { ("Shift", shift), ("Control", ctrl), ("Alt", alt), ("Meta", meta) })
        {
            var held = _held.Where(c => ModifierGroup(c) == group).ToList();
            if (wanted && held.Count == 0)
                SendKey(group + "Left", Evdev[group + "Left"], true);
            else if (!wanted)
                foreach (var code in held)
                    SendKey(code, Evdev[code], false);
        }
    }

    private static string? ModifierGroup(string code) => code switch
    {
        "ShiftLeft" or "ShiftRight" => "Shift",
        "ControlLeft" or "ControlRight" => "Control",
        "AltLeft" or "AltRight" => "Alt",
        "MetaLeft" or "MetaRight" => "Meta",
        _ => null,
    };

    public void Dispose()
    {
        Reset();
        X11.XCloseDisplay(_display);
    }

    /// <summary>KeyboardEvent.code → Linux evdev 키코드 (linux/input-event-codes.h)</summary>
    private static readonly Dictionary<string, int> Evdev = BuildEvdev();

    private static Dictionary<string, int> BuildEvdev()
    {
        var map = new Dictionary<string, int>
        {
            ["Escape"] = 1, ["Minus"] = 12, ["Equal"] = 13, ["Backspace"] = 14, ["Tab"] = 15,
            ["BracketLeft"] = 26, ["BracketRight"] = 27, ["Enter"] = 28, ["ControlLeft"] = 29,
            ["Semicolon"] = 39, ["Quote"] = 40, ["Backquote"] = 41, ["ShiftLeft"] = 42, ["Backslash"] = 43,
            ["Comma"] = 51, ["Period"] = 52, ["Slash"] = 53, ["ShiftRight"] = 54, ["NumpadMultiply"] = 55,
            ["AltLeft"] = 56, ["Space"] = 57, ["CapsLock"] = 58, ["NumLock"] = 69, ["ScrollLock"] = 70,
            ["Numpad7"] = 71, ["Numpad8"] = 72, ["Numpad9"] = 73, ["NumpadSubtract"] = 74,
            ["Numpad4"] = 75, ["Numpad5"] = 76, ["Numpad6"] = 77, ["NumpadAdd"] = 78,
            ["Numpad1"] = 79, ["Numpad2"] = 80, ["Numpad3"] = 81, ["Numpad0"] = 82, ["NumpadDecimal"] = 83,
            ["IntlBackslash"] = 86, ["F11"] = 87, ["F12"] = 88, ["IntlRo"] = 89,
            ["NumpadEnter"] = 96, ["ControlRight"] = 97, ["NumpadDivide"] = 98, ["PrintScreen"] = 99,
            ["AltRight"] = 100, ["Home"] = 102, ["ArrowUp"] = 103, ["PageUp"] = 104, ["ArrowLeft"] = 105,
            ["ArrowRight"] = 106, ["End"] = 107, ["ArrowDown"] = 108, ["PageDown"] = 109, ["Insert"] = 110,
            ["Delete"] = 111, ["NumpadEqual"] = 117, ["Pause"] = 119, ["NumpadComma"] = 121,
            ["Lang1"] = 122, ["Lang2"] = 123, ["IntlYen"] = 124, ["MetaLeft"] = 125, ["MetaRight"] = 126,
            ["ContextMenu"] = 127,
        };
        // 숫자 1~9, 0
        for (var i = 1; i <= 9; i++)
            map[$"Digit{i}"] = 1 + i;
        map["Digit0"] = 11;
        // 글자 (QWERTY 물리 배열)
        var rows = new (string Keys, int Start)[] { ("QWERTYUIOP", 16), ("ASDFGHJKL", 30), ("ZXCVBNM", 44) };
        foreach (var (keys, start) in rows)
            for (var i = 0; i < keys.Length; i++)
                map[$"Key{keys[i]}"] = start + i;
        // F1~F10, F13~F24
        for (var i = 1; i <= 10; i++)
            map[$"F{i}"] = 58 + i;
        for (var i = 13; i <= 24; i++)
            map[$"F{i}"] = 170 + i;
        return map;
    }
}
