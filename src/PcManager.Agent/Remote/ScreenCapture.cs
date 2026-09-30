using System.Drawing;
using System.Runtime.InteropServices;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;

namespace PcManager.Agent.Remote;

internal enum CaptureStatus
{
    /// <summary>새 화면을 버퍼에 담았다</summary>
    NewFrame,
    /// <summary>바뀐 내용이 없다</summary>
    NoChange,
    /// <summary>캡처 장치를 다시 만들어야 한다 (데스크톱 전환, 해상도 변경 등)</summary>
    Lost,
}

/// <summary>한 모니터의 화면을 BGRA(32bpp, stride = Width*4) 버퍼로 가져온다.</summary>
internal interface IScreenCapturer : IDisposable
{
    /// <summary>모니터의 가상 데스크톱 좌표 (물리 픽셀)</summary>
    Rectangle Bounds { get; }

    CaptureStatus Capture(byte[] bgra, int timeoutMs);
}

/// <summary>DXGI Desktop Duplication. 바뀐 화면만 받아 CPU 부담이 적다.</summary>
internal sealed class DxgiCapturer : IScreenCapturer
{
    private const int WaitTimeout = unchecked((int)0x887A0027);
    private const int AccessLost = unchecked((int)0x887A0026);

    private readonly ID3D11Device _device;
    private readonly ID3D11DeviceContext _context;
    private readonly IDXGIOutputDuplication _duplication;
    private readonly ID3D11Texture2D _staging;
    private bool _frameHeld;

    public Rectangle Bounds { get; }

    public DxgiCapturer(Rectangle monitorBounds)
    {
        using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
        for (uint a = 0; factory.EnumAdapters1(a, out var adapter).Success; a++)
        {
            using (adapter)
            {
                for (uint o = 0; adapter.EnumOutputs(o, out var output).Success; o++)
                {
                    using (output)
                    {
                        var r = output.Description.DesktopCoordinates;
                        if (r.Left != monitorBounds.Left || r.Top != monitorBounds.Top)
                            continue;

                        D3D11.D3D11CreateDevice(adapter, DriverType.Unknown, DeviceCreationFlags.BgraSupport,
                            [FeatureLevel.Level_11_0, FeatureLevel.Level_10_1, FeatureLevel.Level_10_0],
                            out ID3D11Device device, out ID3D11DeviceContext context).CheckError();
                        _device = device!;
                        _context = context!;
                        try
                        {
                            using var output1 = output.QueryInterface<IDXGIOutput1>();
                            _duplication = output1.DuplicateOutput(_device);
                        }
                        catch
                        {
                            _context.Dispose();
                            _device.Dispose();
                            throw;
                        }

                        var mode = _duplication.Description.ModeDescription;
                        Bounds = new Rectangle(r.Left, r.Top, (int)mode.Width, (int)mode.Height);
                        _staging = _device.CreateTexture2D(new Texture2DDescription
                        {
                            Width = mode.Width,
                            Height = mode.Height,
                            MipLevels = 1,
                            ArraySize = 1,
                            Format = Format.B8G8R8A8_UNorm,
                            SampleDescription = new SampleDescription(1, 0),
                            Usage = ResourceUsage.Staging,
                            CPUAccessFlags = CpuAccessFlags.Read,
                        });
                        return;
                    }
                }
            }
        }
        throw new InvalidOperationException("DXGI 출력 장치를 찾지 못했습니다.");
    }

    public unsafe CaptureStatus Capture(byte[] bgra, int timeoutMs)
    {
        ReleaseHeldFrame();

        var result = _duplication.AcquireNextFrame((uint)timeoutMs, out var info, out var resource);
        if (result.Code == WaitTimeout)
            return CaptureStatus.NoChange;
        if (result.Code == AccessLost || result.Failure)
            return CaptureStatus.Lost;

        _frameHeld = true;
        using (resource)
        {
            // 마우스만 움직인 경우 화면은 그대로
            if (info.LastPresentTime == 0)
                return CaptureStatus.NoChange;

            using var texture = resource!.QueryInterface<ID3D11Texture2D>();
            _context.CopyResource(_staging, texture);
        }

        var mapped = _context.Map(_staging, 0, MapMode.Read);
        try
        {
            var rowBytes = Bounds.Width * 4;
            fixed (byte* dst = bgra)
            {
                for (var y = 0; y < Bounds.Height; y++)
                {
                    Buffer.MemoryCopy((byte*)mapped.DataPointer + (long)y * mapped.RowPitch, dst + (long)y * rowBytes, rowBytes, rowBytes);
                }
            }
        }
        finally
        {
            _context.Unmap(_staging, 0);
        }
        return CaptureStatus.NewFrame;
    }

    private void ReleaseHeldFrame()
    {
        if (!_frameHeld)
            return;
        _frameHeld = false;
        _duplication.ReleaseFrame();
    }

    public void Dispose()
    {
        try
        {
            ReleaseHeldFrame();
        }
        catch
        {
            // 장치가 이미 사라진 경우
        }
        _staging.Dispose();
        _duplication.Dispose();
        _context.Dispose();
        _device.Dispose();
    }
}

/// <summary>
/// GDI BitBlt 캡처. DXGI를 쓸 수 없는 환경(일부 VM, 원격 데스크톱 세션 등)을 위한 대체 경로.
/// 변경 감지가 없어서 이전 프레임과 비교해 같으면 NoChange로 돌려준다.
/// </summary>
internal sealed class GdiCapturer : IScreenCapturer
{
    private readonly IntPtr _memDc;
    private readonly IntPtr _bitmap;
    private readonly IntPtr _oldBitmap;
    private readonly IntPtr _bits;
    private byte[]? _previous;

    public Rectangle Bounds { get; }

    public GdiCapturer(Rectangle monitorBounds)
    {
        Bounds = monitorBounds;
        var screenDc = GetDC(IntPtr.Zero);
        try
        {
            _memDc = CreateCompatibleDC(screenDc);
            var info = new BITMAPINFOHEADER
            {
                biSize = Marshal.SizeOf<BITMAPINFOHEADER>(),
                biWidth = Bounds.Width,
                biHeight = -Bounds.Height, // 위에서 아래로
                biPlanes = 1,
                biBitCount = 32,
            };
            _bitmap = CreateDIBSection(screenDc, ref info, 0, out _bits, IntPtr.Zero, 0);
            if (_bitmap == IntPtr.Zero)
            {
                DeleteDC(_memDc);
                throw new InvalidOperationException("GDI 캡처 비트맵을 만들지 못했습니다.");
            }
            _oldBitmap = SelectObject(_memDc, _bitmap);
        }
        finally
        {
            ReleaseDC(IntPtr.Zero, screenDc);
        }
    }

    public CaptureStatus Capture(byte[] bgra, int timeoutMs)
    {
        var screenDc = GetDC(IntPtr.Zero);
        if (screenDc == IntPtr.Zero)
            return CaptureStatus.Lost;
        try
        {
            if (!BitBlt(_memDc, 0, 0, Bounds.Width, Bounds.Height, screenDc, Bounds.Left, Bounds.Top, SRCCOPY | CAPTUREBLT))
                return CaptureStatus.Lost;
        }
        finally
        {
            ReleaseDC(IntPtr.Zero, screenDc);
        }

        var length = Bounds.Width * Bounds.Height * 4;
        Marshal.Copy(_bits, bgra, 0, length);
        if (_previous is not null && bgra.AsSpan(0, length).SequenceEqual(_previous))
        {
            // 너무 자주 비교하지 않게 대기 시간만큼 쉰다
            Thread.Sleep(Math.Min(timeoutMs, 50));
            return CaptureStatus.NoChange;
        }
        _previous ??= new byte[length];
        bgra.AsSpan(0, length).CopyTo(_previous);
        return CaptureStatus.NewFrame;
    }

    public void Dispose()
    {
        SelectObject(_memDc, _oldBitmap);
        DeleteObject(_bitmap);
        DeleteDC(_memDc);
    }

    private const int SRCCOPY = 0x00CC0020;
    private const int CAPTUREBLT = 0x40000000;

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

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr dc);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr dc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER info, int usage, out IntPtr bits, IntPtr section, int offset);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr obj);

    [DllImport("gdi32.dll")]
    private static extern bool BitBlt(IntPtr dest, int x, int y, int w, int h, IntPtr src, int sx, int sy, int rop);
}
