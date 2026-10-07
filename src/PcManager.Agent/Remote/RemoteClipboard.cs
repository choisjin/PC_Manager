using System.Runtime.InteropServices;

namespace PcManager.Agent.Remote;

/// <summary>
/// 원격 PC(세션)의 클립보드(텍스트, 복사한 파일 목록)를 읽고 쓴다. 반드시 입력 데스크톱에 붙은 스레드에서 호출해야 한다
/// (클립보드는 윈도우 스테이션/데스크톱에 묶여 있다). 원격조작 중 클립보드 동기화에 쓴다.
/// </summary>
internal static class RemoteClipboard
{
    private const uint CF_UNICODETEXT = 13;
    private const uint GMEM_MOVEABLE = 0x0002;

    public static string? GetText()
    {
        if (!IsClipboardFormatAvailable(CF_UNICODETEXT))
            return null;
        if (!OpenClipboard(IntPtr.Zero))
            return null;
        try
        {
            var handle = GetClipboardData(CF_UNICODETEXT);
            if (handle == IntPtr.Zero)
                return null;
            var ptr = GlobalLock(handle);
            if (ptr == IntPtr.Zero)
                return null;
            try
            {
                return Marshal.PtrToStringUni(ptr);
            }
            finally
            {
                GlobalUnlock(handle);
            }
        }
        finally
        {
            CloseClipboard();
        }
    }

    public static bool SetText(string text)
    {
        if (!OpenClipboard(IntPtr.Zero))
            return false;
        try
        {
            EmptyClipboard();
            var bytes = (text.Length + 1) * 2;
            var global = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)bytes);
            if (global == IntPtr.Zero)
                return false;
            var ptr = GlobalLock(global);
            if (ptr == IntPtr.Zero)
            {
                GlobalFree(global);
                return false;
            }
            try
            {
                Marshal.Copy(text.ToCharArray(), 0, ptr, text.Length);
                Marshal.WriteInt16(ptr, text.Length * 2, 0);
            }
            finally
            {
                GlobalUnlock(global);
            }
            // 소유권이 클립보드로 넘어가므로 성공 시 GlobalFree를 호출하지 않는다
            if (SetClipboardData(CF_UNICODETEXT, global) == IntPtr.Zero)
            {
                GlobalFree(global);
                return false;
            }
            return true;
        }
        finally
        {
            CloseClipboard();
        }
    }

    /// <summary>클립보드가 바뀔 때마다 늘어나는 번호 (열지 않고 변경 여부만 볼 때)</summary>
    public static uint SequenceNumber => GetClipboardSequenceNumber();

    /// <summary>탐색기 등에서 복사한 파일·폴더 경로 (CF_HDROP). 없으면 null</summary>
    public static IReadOnlyList<string>? GetFiles()
    {
        if (!IsClipboardFormatAvailable(CF_HDROP))
            return null;
        if (!OpenClipboard(IntPtr.Zero))
            return null;
        try
        {
            var handle = GetClipboardData(CF_HDROP);
            if (handle == IntPtr.Zero)
                return null;
            var count = DragQueryFile(handle, 0xFFFFFFFF, null, 0);
            var files = new List<string>((int)count);
            for (uint i = 0; i < count; i++)
            {
                var length = DragQueryFile(handle, i, null, 0);
                var buffer = new char[length + 1];
                if (DragQueryFile(handle, i, buffer, (uint)buffer.Length) > 0)
                    files.Add(new string(buffer, 0, (int)length));
            }
            return files;
        }
        finally
        {
            CloseClipboard();
        }
    }

    /// <summary>파일 목록을 '복사'로 클립보드에 넣는다 (CF_HDROP + Preferred DropEffect). 붙여넣으면 탐색기가 복사한다</summary>
    public static bool SetFiles(IReadOnlyList<string> paths)
    {
        // DROPFILES(20바이트) + 경로들(각각 NUL 끝) + 마지막 NUL, 유니코드
        const int header = 20;
        var chars = paths.Sum(p => p.Length + 1) + 1;
        var drop = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)(header + chars * 2));
        if (drop == IntPtr.Zero)
            return false;
        var ptr = GlobalLock(drop);
        if (ptr == IntPtr.Zero)
        {
            GlobalFree(drop);
            return false;
        }
        try
        {
            Marshal.WriteInt32(ptr, 0, header); // pFiles
            Marshal.WriteInt64(ptr, 4, 0);      // pt
            Marshal.WriteInt32(ptr, 12, 0);     // fNC
            Marshal.WriteInt32(ptr, 16, 1);     // fWide
            var offset = header;
            foreach (var path in paths)
            {
                Marshal.Copy(path.ToCharArray(), 0, ptr + offset, path.Length);
                offset += path.Length * 2;
                Marshal.WriteInt16(ptr, offset, 0);
                offset += 2;
            }
            Marshal.WriteInt16(ptr, offset, 0);
        }
        finally
        {
            GlobalUnlock(drop);
        }

        var effect = GlobalAlloc(GMEM_MOVEABLE, 4);
        if (effect != IntPtr.Zero && GlobalLock(effect) is var effectPtr && effectPtr != IntPtr.Zero)
        {
            Marshal.WriteInt32(effectPtr, DROPEFFECT_COPY);
            GlobalUnlock(effect);
        }

        if (!OpenClipboard(IntPtr.Zero))
        {
            GlobalFree(drop);
            if (effect != IntPtr.Zero)
                GlobalFree(effect);
            return false;
        }
        try
        {
            EmptyClipboard();
            // 소유권이 클립보드로 넘어가므로 성공 시 GlobalFree를 호출하지 않는다
            if (SetClipboardData(CF_HDROP, drop) == IntPtr.Zero)
            {
                GlobalFree(drop);
                if (effect != IntPtr.Zero)
                    GlobalFree(effect);
                return false;
            }
            if (effect != IntPtr.Zero && SetClipboardData(RegisterClipboardFormat("Preferred DropEffect"), effect) == IntPtr.Zero)
                GlobalFree(effect);
            return true;
        }
        finally
        {
            CloseClipboard();
        }
    }

    private const uint CF_HDROP = 15;
    private const int DROPEFFECT_COPY = 1;

    [DllImport("user32.dll")]
    private static extern uint GetClipboardSequenceNumber();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint RegisterClipboardFormat(string format);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern uint DragQueryFile(IntPtr hDrop, uint index, char[]? file, uint length);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool OpenClipboard(IntPtr hWndNewOwner);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EmptyClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool IsClipboardFormatAvailable(uint format);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetClipboardData(uint format);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetClipboardData(uint format, IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalFree(IntPtr hMem);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GlobalLock(IntPtr hMem);

    [DllImport("kernel32.dll")]
    private static extern bool GlobalUnlock(IntPtr hMem);
}
