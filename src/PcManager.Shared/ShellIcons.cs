using System.Collections.Concurrent;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace PcManager.Shared;

/// <summary>
/// 이 PC에 설치된 윈도우 셸 아이콘(탐색기와 같은 확장자별 아이콘)을 PNG로 꺼낸다.
/// 아이콘 파일을 배포하지 않고, 실행 중인 PC의 윈도우에서 그때그때 받아 쓴다 (엑셀이 설치돼 있으면 엑셀 아이콘).
/// </summary>
[SupportedOSPlatform("windows")]
public static class ShellIcons
{
    private static readonly ConcurrentDictionary<string, byte[]?> Cache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>폴더 아이콘을 뜻하는 확장자 자리 값</summary>
    public const string FolderKey = "<folder>";

    /// <param name="extension">"xlsx"처럼 점 없이. FolderKey면 폴더 아이콘</param>
    /// <param name="size">16, 32, 48, 256 중 가까운 크기로 꺼낸다</param>
    /// <returns>PNG. 꺼내지 못하면 null</returns>
    public static byte[]? GetPng(string extension, int size)
    {
        var ext = extension.Trim().TrimStart('.').ToLowerInvariant();
        if (ext.Length > 16 || ext.Any(c => !char.IsLetterOrDigit(c) && c != '_' && c != '-' && c != '<' && c != '>'))
            return null;
        var list = size <= 16 ? ShilSmall : size <= 32 ? ShilLarge : size <= 48 ? ShilExtraLarge : ShilJumbo;
        return Cache.GetOrAdd($"{ext}|{list}", _ => RunSta(() => Extract(ext, list)));
    }

    // 셸 함수는 STA 스레드에서, 그리고 셸 이미지 목록(프로세스 공용 COM 개체)을 여러 스레드가 동시에 쓰지 않도록
    // 전용 스레드 하나에서 차례로 처리한다
    private static readonly System.Collections.Concurrent.BlockingCollection<(Func<byte[]?> Work, TaskCompletionSource<byte[]?> Done)> Queue = StartWorker();

    private static System.Collections.Concurrent.BlockingCollection<(Func<byte[]?>, TaskCompletionSource<byte[]?>)> StartWorker()
    {
        var queue = new System.Collections.Concurrent.BlockingCollection<(Func<byte[]?>, TaskCompletionSource<byte[]?>)>();
        var thread = new Thread(() =>
        {
            foreach (var (work, done) in queue.GetConsumingEnumerable())
            {
                try
                {
                    done.TrySetResult(work());
                }
                catch (Exception)
                {
                    // 아이콘 하나 실패로 프로세스가 죽으면 안 된다 → 대체 아이콘을 쓰게 null
                    done.TrySetResult(null);
                }
            }
        })
        {
            IsBackground = true,
            Name = "ShellIcons",
        };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        return queue;
    }

    private static byte[]? RunSta(Func<byte[]?> work)
    {
        var done = new TaskCompletionSource<byte[]?>(TaskCreationOptions.RunContinuationsAsynchronously);
        Queue.Add((work, done));
        return done.Task.Wait(TimeSpan.FromSeconds(10)) ? done.Task.Result : null;
    }

    private static byte[]? Extract(string ext, int imageList)
    {
        var isFolder = ext == FolderKey;
        var info = new SHFILEINFO();
        var path = isFolder ? "folder" : "file." + ext;
        var attributes = isFolder ? FileAttributeDirectory : FileAttributeNormal;
        if (SHGetFileInfo(path, attributes, ref info, (uint)Marshal.SizeOf<SHFILEINFO>(), ShgfiSysIconIndex | ShgfiUseFileAttributes) == IntPtr.Zero)
            return null;

        var iid = typeof(IImageList).GUID;
        if (SHGetImageList(imageList, ref iid, out var images) != 0 || images is null)
            return null;
        var hIcon = IntPtr.Zero;
        try
        {
            if (images.GetIcon(info.iIcon, IldTransparent, ref hIcon) != 0 || hIcon == IntPtr.Zero)
                return null;
            return IconToPng(hIcon);
        }
        finally
        {
            // 셸 이미지 목록은 프로세스 공용이라 해제하지 않는다 (해제하면 다른 호출이 깨진다)
            if (hIcon != IntPtr.Zero)
                DestroyIcon(hIcon);
        }
    }

    /// <summary>HICON → 32비트 RGBA PNG (투명도 유지)</summary>
    private static byte[]? IconToPng(IntPtr hIcon)
    {
        if (!GetIconInfo(hIcon, out var iconInfo))
            return null;
        try
        {
            if (iconInfo.hbmColor == IntPtr.Zero)
                return null;
            if (GetObject(iconInfo.hbmColor, Marshal.SizeOf<BITMAP>(), out var bitmap) == 0)
                return null;
            var width = bitmap.bmWidth;
            var height = bitmap.bmHeight;
            var bgra = ReadBits(iconInfo.hbmColor, width, height);
            if (bgra is null)
                return null;

            // 알파가 전혀 없는 옛 아이콘은 마스크로 투명도를 만든다
            var hasAlpha = false;
            for (var i = 3; i < bgra.Length; i += 4)
            {
                if (bgra[i] != 0)
                {
                    hasAlpha = true;
                    break;
                }
            }
            if (!hasAlpha)
            {
                var mask = iconInfo.hbmMask != IntPtr.Zero ? ReadBits(iconInfo.hbmMask, width, height) : null;
                for (var i = 0; i < bgra.Length; i += 4)
                    bgra[i + 3] = mask is not null && mask[i] != 0 ? (byte)0 : (byte)255;
            }

            // 실제로 그려진 영역이 없으면(빈 아이콘) 실패로 본다
            if (!bgra.Where((_, i) => i % 4 == 3).Any(a => a != 0))
                return null;
            return EncodePng(bgra, width, height);
        }
        finally
        {
            if (iconInfo.hbmColor != IntPtr.Zero)
                DeleteObject(iconInfo.hbmColor);
            if (iconInfo.hbmMask != IntPtr.Zero)
                DeleteObject(iconInfo.hbmMask);
        }
    }

    private static byte[]? ReadBits(IntPtr hBitmap, int width, int height)
    {
        var header = new BITMAPINFOHEADER
        {
            biSize = Marshal.SizeOf<BITMAPINFOHEADER>(),
            biWidth = width,
            biHeight = -height, // 위에서 아래로
            biPlanes = 1,
            biBitCount = 32,
        };
        var bits = new byte[width * height * 4];
        var dc = GetDC(IntPtr.Zero);
        try
        {
            return GetDIBits(dc, hBitmap, 0, (uint)height, bits, ref header, 0) == 0 ? null : bits;
        }
        finally
        {
            ReleaseDC(IntPtr.Zero, dc);
        }
    }

    // ── 최소 PNG 인코더 (RGBA 8비트, 필터 없음) ──

    private static byte[] EncodePng(byte[] bgra, int width, int height)
    {
        using var raw = new MemoryStream();
        using (var z = new ZLibStream(raw, CompressionLevel.Optimal, leaveOpen: true))
        {
            var row = new byte[1 + width * 4];
            for (var y = 0; y < height; y++)
            {
                row[0] = 0;
                for (var x = 0; x < width; x++)
                {
                    var s = (y * width + x) * 4;
                    var d = 1 + x * 4;
                    row[d] = bgra[s + 2];
                    row[d + 1] = bgra[s + 1];
                    row[d + 2] = bgra[s];
                    row[d + 3] = bgra[s + 3];
                }
                z.Write(row);
            }
        }

        using var png = new MemoryStream();
        png.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        var ihdr = new byte[13];
        WriteBigEndian(ihdr, 0, (uint)width);
        WriteBigEndian(ihdr, 4, (uint)height);
        ihdr[8] = 8; // 비트 깊이
        ihdr[9] = 6; // RGBA
        WriteChunk(png, "IHDR", ihdr);
        WriteChunk(png, "IDAT", raw.ToArray());
        WriteChunk(png, "IEND", []);
        return png.ToArray();
    }

    private static void WriteChunk(Stream output, string type, byte[] data)
    {
        var length = new byte[4];
        WriteBigEndian(length, 0, (uint)data.Length);
        output.Write(length);
        var typeBytes = System.Text.Encoding.ASCII.GetBytes(type);
        output.Write(typeBytes);
        output.Write(data);
        var crc = Crc32(typeBytes, data);
        var crcBytes = new byte[4];
        WriteBigEndian(crcBytes, 0, crc);
        output.Write(crcBytes);
    }

    private static void WriteBigEndian(byte[] buffer, int offset, uint value)
    {
        buffer[offset] = (byte)(value >> 24);
        buffer[offset + 1] = (byte)(value >> 16);
        buffer[offset + 2] = (byte)(value >> 8);
        buffer[offset + 3] = (byte)value;
    }

    private static readonly uint[] CrcTable = Enumerable.Range(0, 256).Select(n =>
    {
        var c = (uint)n;
        for (var k = 0; k < 8; k++)
            c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
        return c;
    }).ToArray();

    private static uint Crc32(byte[] type, byte[] data)
    {
        var crc = 0xFFFFFFFF;
        foreach (var b in type)
            crc = CrcTable[(crc ^ b) & 0xFF] ^ (crc >> 8);
        foreach (var b in data)
            crc = CrcTable[(crc ^ b) & 0xFF] ^ (crc >> 8);
        return crc ^ 0xFFFFFFFF;
    }

    // ── Win32 ──

    private const uint FileAttributeNormal = 0x80;
    private const uint FileAttributeDirectory = 0x10;
    private const uint ShgfiSysIconIndex = 0x4000;
    private const uint ShgfiUseFileAttributes = 0x10;
    private const int IldTransparent = 1;
    private const int ShilLarge = 0;      // 32
    private const int ShilSmall = 1;      // 16
    private const int ShilExtraLarge = 2; // 48
    private const int ShilJumbo = 4;      // 256

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEINFO
    {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szDisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)]
        public string szTypeName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ICONINFO
    {
        public bool fIcon;
        public int xHotspot;
        public int yHotspot;
        public IntPtr hbmMask;
        public IntPtr hbmColor;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAP
    {
        public int bmType;
        public int bmWidth;
        public int bmHeight;
        public int bmWidthBytes;
        public ushort bmPlanes;
        public ushort bmBitsPixel;
        public IntPtr bmBits;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public int biSize;
        public int biWidth;
        public int biHeight;
        public short biPlanes;
        public short biBitCount;
        public int biCompression;
        public int biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public int biClrUsed;
        public int biClrImportant;
    }

    [ComImport]
    [Guid("46EB5926-582E-4017-9FDF-E8998DAA0950")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IImageList
    {
        [PreserveSig] int Add(IntPtr hbmImage, IntPtr hbmMask, ref int pi);
        [PreserveSig] int ReplaceIcon(int i, IntPtr hicon, ref int pi);
        [PreserveSig] int SetOverlayImage(int iImage, int iOverlay);
        [PreserveSig] int Replace(int i, IntPtr hbmImage, IntPtr hbmMask);
        [PreserveSig] int AddMasked(IntPtr hbmImage, int crMask, ref int pi);
        [PreserveSig] int Draw(IntPtr pimldp);
        [PreserveSig] int Remove(int i);
        [PreserveSig] int GetIcon(int i, int flags, ref IntPtr picon);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);

    [DllImport("shell32.dll", EntryPoint = "#727")]
    private static extern int SHGetImageList(int iImageList, ref Guid riid, out IImageList ppv);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    [DllImport("user32.dll")]
    private static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);

    [DllImport("gdi32.dll")]
    private static extern int GetObject(IntPtr h, int c, out BITMAP pv);

    [DllImport("gdi32.dll")]
    private static extern int GetDIBits(IntPtr hdc, IntPtr hbm, uint start, uint cLines, byte[] lpvBits, ref BITMAPINFOHEADER lpbmi, uint usage);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr ho);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
}
