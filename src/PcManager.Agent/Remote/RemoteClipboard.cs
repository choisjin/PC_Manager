using System.Runtime.InteropServices;

namespace PcManager.Agent.Remote;

/// <summary>
/// 원격 PC(세션)의 텍스트 클립보드를 읽고 쓴다. 반드시 입력 데스크톱에 붙은 스레드에서 호출해야 한다
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
