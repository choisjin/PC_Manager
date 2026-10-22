using System.Runtime.InteropServices;

namespace PcManager.Agent.Linux.Launcher;

/// <summary>
/// 런처 창에 쓰는 GTK 3 함수만 직접 부른다 (Ubuntu 데스크톱에 기본 설치된 libgtk-3, 별도 패키지·UI 프레임워크 없이).
/// GTK는 이 프로세스의 메인 스레드에서만 만진다 — 다른 스레드는 <see cref="Post"/>로 넘긴다
/// </summary>
internal static unsafe partial class Gtk
{
    private const string LibGtk = "libgtk-3.so.0";
    private const string LibGObject = "libgobject-2.0.so.0";
    private const string LibGLib = "libglib-2.0.so.0";
    private const string LibGio = "libgio-2.0.so.0";

    public const int OrientationHorizontal = 0;
    public const int OrientationVertical = 1;
    public const int ReliefNone = 2;
    public const int AlignStart = 1;

    [LibraryImport(LibGLib, StringMarshalling = StringMarshalling.Utf8)]
    public static partial void g_set_prgname(string name);

    [LibraryImport(LibGtk, StringMarshalling = StringMarshalling.Utf8)]
    public static partial IntPtr gtk_application_new(string applicationId, int flags);

    [LibraryImport(LibGio)]
    public static partial int g_application_run(IntPtr application, int argc, IntPtr argv);

    [LibraryImport(LibGio)]
    public static partial void g_application_quit(IntPtr application);

    [LibraryImport(LibGObject)]
    public static partial void g_object_unref(IntPtr instance);

    [LibraryImport(LibGObject, StringMarshalling = StringMarshalling.Utf8)]
    private static partial ulong g_signal_connect_data(IntPtr instance, string signal, IntPtr handler, IntPtr data, IntPtr destroy, int flags);

    [LibraryImport(LibGLib)]
    private static partial uint g_timeout_add(uint intervalMs, delegate* unmanaged<IntPtr, int> function, IntPtr data);

    [LibraryImport(LibGLib)]
    private static partial uint g_idle_add(delegate* unmanaged<IntPtr, int> function, IntPtr data);

    [LibraryImport(LibGtk)]
    public static partial IntPtr gtk_application_window_new(IntPtr application);

    [LibraryImport(LibGtk, StringMarshalling = StringMarshalling.Utf8)]
    public static partial void gtk_window_set_title(IntPtr window, string title);

    [LibraryImport(LibGtk)]
    public static partial void gtk_window_set_resizable(IntPtr window, [MarshalAs(UnmanagedType.I4)] bool resizable);

    [LibraryImport(LibGtk, StringMarshalling = StringMarshalling.Utf8)]
    public static partial int gtk_window_set_icon_from_file(IntPtr window, string path, IntPtr error);

    [LibraryImport(LibGtk)]
    public static partial void gtk_window_present(IntPtr window);

    [LibraryImport(LibGtk)]
    public static partial void gtk_window_iconify(IntPtr window);

    [LibraryImport(LibGtk)]
    public static partial IntPtr gtk_box_new(int orientation, int spacing);

    [LibraryImport(LibGtk)]
    public static partial void gtk_box_pack_start(IntPtr box, IntPtr child, [MarshalAs(UnmanagedType.I4)] bool expand, [MarshalAs(UnmanagedType.I4)] bool fill, uint padding);

    [LibraryImport(LibGtk)]
    public static partial void gtk_container_add(IntPtr container, IntPtr widget);

    [LibraryImport(LibGtk)]
    public static partial void gtk_container_set_border_width(IntPtr container, uint width);

    [LibraryImport(LibGtk, StringMarshalling = StringMarshalling.Utf8)]
    public static partial IntPtr gtk_label_new(string? text);

    [LibraryImport(LibGtk, StringMarshalling = StringMarshalling.Utf8)]
    public static partial void gtk_label_set_text(IntPtr label, string text);

    [LibraryImport(LibGtk, StringMarshalling = StringMarshalling.Utf8)]
    public static partial void gtk_label_set_markup(IntPtr label, string markup);

    [LibraryImport(LibGtk)]
    public static partial void gtk_label_set_xalign(IntPtr label, float xalign);

    [LibraryImport(LibGtk)]
    public static partial void gtk_label_set_line_wrap(IntPtr label, [MarshalAs(UnmanagedType.I4)] bool wrap);

    [LibraryImport(LibGtk)]
    public static partial void gtk_label_set_max_width_chars(IntPtr label, int chars);

    [LibraryImport(LibGtk)]
    public static partial void gtk_label_set_selectable(IntPtr label, [MarshalAs(UnmanagedType.I4)] bool selectable);

    [LibraryImport(LibGtk)]
    public static partial IntPtr gtk_entry_new();

    [LibraryImport(LibGtk, StringMarshalling = StringMarshalling.Utf8)]
    public static partial void gtk_entry_set_text(IntPtr entry, string text);

    [LibraryImport(LibGtk)]
    private static partial IntPtr gtk_entry_get_text(IntPtr entry);

    public static string GetEntryText(IntPtr entry) => Marshal.PtrToStringUTF8(gtk_entry_get_text(entry)) ?? "";

    [LibraryImport(LibGtk, StringMarshalling = StringMarshalling.Utf8)]
    public static partial void gtk_entry_set_placeholder_text(IntPtr entry, string text);

    [LibraryImport(LibGtk, StringMarshalling = StringMarshalling.Utf8)]
    public static partial IntPtr gtk_button_new_with_label(string label);

    [LibraryImport(LibGtk, StringMarshalling = StringMarshalling.Utf8)]
    public static partial void gtk_button_set_label(IntPtr button, string label);

    [LibraryImport(LibGtk)]
    public static partial void gtk_button_set_relief(IntPtr button, int relief);

    [LibraryImport(LibGtk)]
    public static partial IntPtr gtk_separator_new(int orientation);

    [LibraryImport(LibGtk)]
    public static partial void gtk_widget_set_sensitive(IntPtr widget, [MarshalAs(UnmanagedType.I4)] bool sensitive);

    [LibraryImport(LibGtk)]
    public static partial void gtk_widget_set_visible(IntPtr widget, [MarshalAs(UnmanagedType.I4)] bool visible);

    [LibraryImport(LibGtk)]
    public static partial void gtk_widget_set_no_show_all(IntPtr widget, [MarshalAs(UnmanagedType.I4)] bool noShowAll);

    [LibraryImport(LibGtk)]
    public static partial void gtk_widget_set_halign(IntPtr widget, int align);

    [LibraryImport(LibGtk)]
    public static partial void gtk_widget_set_size_request(IntPtr widget, int width, int height);

    [LibraryImport(LibGtk)]
    [return: MarshalAs(UnmanagedType.I4)]
    public static partial bool gtk_widget_has_focus(IntPtr widget);

    [LibraryImport(LibGtk)]
    public static partial void gtk_widget_show_all(IntPtr widget);

    [LibraryImport(LibGtk)]
    public static partial void gtk_widget_grab_focus(IntPtr widget);

    // ───── 신호·타이머 → C# 콜백 (user_data = 등록 번호) ─────

    private static readonly Dictionary<IntPtr, Action> Handlers = [];
    private static readonly Dictionary<IntPtr, Func<bool>> DeleteHandlers = [];
    private static readonly Dictionary<IntPtr, Func<bool>> Timers = [];
    private static readonly System.Collections.Concurrent.ConcurrentQueue<Action> Posted = new();
    private static long _nextId;

    private static IntPtr NextId() => (IntPtr)Interlocked.Increment(ref _nextId);

    /// <summary>void 신호(clicked·activate·changed)에 C# 처리기를 붙인다</summary>
    public static void On(IntPtr instance, string signal, Action handler)
    {
        var id = NextId();
        Handlers[id] = handler;
        g_signal_connect_data(instance, signal, (IntPtr)(delegate* unmanaged<IntPtr, IntPtr, void>)&OnSignal, id, IntPtr.Zero, 0);
    }

    /// <summary>창 닫기(X)를 가로챈다. 처리기가 true를 돌려주면 창을 닫지 않는다</summary>
    public static void OnDelete(IntPtr window, Func<bool> handler)
    {
        var id = NextId();
        DeleteHandlers[id] = handler;
        g_signal_connect_data(window, "delete-event", (IntPtr)(delegate* unmanaged<IntPtr, IntPtr, IntPtr, int>)&OnDeleteEvent, id, IntPtr.Zero, 0);
    }

    /// <summary>주기 실행. 처리기가 false를 돌려주면 멈춘다</summary>
    public static void Every(TimeSpan interval, Func<bool> tick)
    {
        var id = NextId();
        Timers[id] = tick;
        g_timeout_add((uint)interval.TotalMilliseconds, &OnTimer, id);
    }

    /// <summary>다른 스레드에서 GTK 메인 스레드로 작업을 넘긴다 (g_idle_add는 스레드 안전)</summary>
    public static void Post(Action action)
    {
        Posted.Enqueue(action);
        g_idle_add(&OnIdle, IntPtr.Zero);
    }

    [UnmanagedCallersOnly]
    private static void OnSignal(IntPtr instance, IntPtr data) => Invoke(() => Handlers[data]());

    [UnmanagedCallersOnly]
    private static int OnDeleteEvent(IntPtr widget, IntPtr gdkEvent, IntPtr data)
    {
        var keepOpen = false;
        Invoke(() => keepOpen = DeleteHandlers[data]());
        return keepOpen ? 1 : 0;
    }

    [UnmanagedCallersOnly]
    private static int OnTimer(IntPtr data)
    {
        var again = false;
        Invoke(() => again = Timers[data]());
        if (!again)
            Timers.Remove(data);
        return again ? 1 : 0;
    }

    [UnmanagedCallersOnly]
    private static int OnIdle(IntPtr data)
    {
        if (Posted.TryDequeue(out var action))
            Invoke(action);
        return 0; // 한 번만 (Post마다 g_idle_add 한 번)
    }

    /// <summary>네이티브 콜백 밖으로 예외가 나가면 프로세스가 죽으므로 여기서 막는다</summary>
    private static void Invoke(Action action)
    {
        try
        {
            action();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"런처 오류: {ex}");
        }
    }
}
