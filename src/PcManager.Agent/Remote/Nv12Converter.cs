using System.Runtime.CompilerServices;
using System.Runtime.Intrinsics;

namespace PcManager.Agent.Remote;

/// <summary>
/// BGRA → NV12 (BT.709, 제한 범위) 변환. 원본을 임의의 더 작은 크기로 줄이며 변환한다
/// (대시보드 PC 해상도에 맞춰 스트림 크기를 정하기 위해). 같은 크기면 1:1, 줄일 때는 영역 평균(박스 필터)으로
/// 글자가 깨지지 않게 한다. 행 두 줄 단위로 여러 코어에서 처리한다.
/// 원격조작에서 CPU를 가장 많이 쓰는 단계라(인코딩은 GPU) SIMD로 8픽셀씩 계산한다 — 결과는 픽셀 하나씩 계산한 것과 같다
/// </summary>
// 줄마다 잡는 stackalloc 버퍼는 곧바로 다 채우므로 0으로 지우지 않는다
[SkipLocalsInit]
internal static class Nv12Converter
{
    // 픽셀 8개(BGRA 32바이트 = 128비트 둘)에서 B·G·R을 뽑는 자리: 앞 16바이트에서 0~3번, 뒤 16바이트에서 4~7번 (범위 밖 = 0)
    private static readonly Vector128<byte> PickB0 = Vector128.Create((byte)0, 4, 8, 12, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255);
    private static readonly Vector128<byte> PickB1 = Vector128.Create((byte)255, 255, 255, 255, 0, 4, 8, 12, 255, 255, 255, 255, 255, 255, 255, 255);
    private static readonly Vector128<byte> PickG0 = Vector128.Create((byte)1, 5, 9, 13, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255);
    private static readonly Vector128<byte> PickG1 = Vector128.Create((byte)255, 255, 255, 255, 1, 5, 9, 13, 255, 255, 255, 255, 255, 255, 255, 255);
    private static readonly Vector128<byte> PickR0 = Vector128.Create((byte)2, 6, 10, 14, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255);
    private static readonly Vector128<byte> PickR1 = Vector128.Create((byte)255, 255, 255, 255, 2, 6, 10, 14, 255, 255, 255, 255, 255, 255, 255, 255);

    /// <param name="srcWidth">원본 폭 (stride = srcWidth*4)</param>
    /// <param name="srcHeight">원본 높이</param>
    /// <param name="dstWidth">출력 폭 (짝수, srcWidth 이하)</param>
    /// <param name="dstHeight">출력 높이 (짝수, srcHeight 이하)</param>
    public static unsafe void Convert(byte[] bgra, int srcWidth, int srcHeight, byte[] nv12, int dstWidth, int dstHeight)
    {
        if (srcWidth == dstWidth && srcHeight == dstHeight)
        {
            ConvertSameSize(bgra, srcWidth, srcHeight, nv12);
            return;
        }

        // 출력 열 x가 덮는 원본 열 구간 [xs[x], xs[x+1])
        var xs = new int[dstWidth + 1];
        for (var x = 0; x <= dstWidth; x++)
            xs[x] = (int)((long)x * srcWidth / dstWidth);
        // 출력 열 x가 덮는 원본 열 수 (1 이상)
        var spans = new int[dstWidth];
        for (var x = 0; x < dstWidth; x++)
            spans[x] = Math.Max(1, xs[x + 1] - xs[x]);
        // 평균 낼 픽셀 수 n의 역수 (나눗셈 대신 곱셈: (v * ceil(2^32/n)) >> 32 = v / n, v < 2^32/n이면 정확)
        var maxSpanX = spans.Max();
        var maxSpanY = (srcHeight + dstHeight - 1) / dstHeight + 1;
        var inverse = new ulong[maxSpanX * maxSpanY + 1];
        for (var n = 1; n < inverse.Length; n++)
            inverse[n] = ((1UL << 32) + (ulong)n - 1) / (ulong)n;

        fixed (byte* srcPtr = bgra)
        fixed (byte* dstPtr = nv12)
        fixed (int* xsPtr = xs)
        fixed (int* spanPtr = spans)
        fixed (ulong* invPtr = inverse)
        {
            var src = srcPtr;
            var dst = dstPtr;
            var xmap = xsPtr;
            var spanOf = spanPtr;
            var inv = invPtr;
            var srcStride = srcWidth * 4;
            var uvPlane = dst + dstWidth * dstHeight;

            Parallel.For(0, dstHeight / 2, pair =>
            {
                // 출력 두 줄(y0, y0+1)의 R·G·B 평균을 줄마다 따로(평면으로) 구한 뒤 Y와 UV를 만든다
                var planes = stackalloc ushort[dstWidth * 6];
                var r0 = planes;
                var g0 = r0 + dstWidth;
                var b0 = g0 + dstWidth;
                var r1 = b0 + dstWidth;
                var g1 = r1 + dstWidth;
                var b1 = g1 + dstWidth;
                // 원본 열마다 이 출력 줄이 덮는 원본 줄들의 합 (세로 먼저 SIMD로, 그다음 가로 구간을 더한다)
                var columns = stackalloc ushort[srcWidth * 3];
                var cr = columns;
                var cg = cr + srcWidth;
                var cb = cg + srcWidth;
                for (var row = 0; row < 2; row++)
                {
                    var y = pair * 2 + row;
                    var sy0 = (int)((long)y * srcHeight / dstHeight);
                    var sy1 = Math.Max(sy0 + 1, (int)((long)(y + 1) * srcHeight / dstHeight));
                    SumRows(src, srcStride, srcWidth, sy0, sy1, cr, cg, cb);
                    var rr = row == 0 ? r0 : r1;
                    var gg = row == 0 ? g0 : g1;
                    var bb = row == 0 ? b0 : b1;
                    var rows = sy1 - sy0;
                    for (var x = 0; x < dstWidth; x++)
                    {
                        var sx = xmap[x];
                        var k = spanOf[x];
                        int r = cr[sx], g = cg[sx], b = cb[sx];
                        for (var j = 1; j < k; j++)
                        {
                            r += cr[sx + j];
                            g += cg[sx + j];
                            b += cb[sx + j];
                        }
                        var n = k * rows;
                        var m = inv[n];
                        rr[x] = (ushort)(((ulong)(r + n / 2) * m) >> 32);
                        gg[x] = (ushort)(((ulong)(g + n / 2) * m) >> 32);
                        bb[x] = (ushort)(((ulong)(b + n / 2) * m) >> 32);
                    }
                }
                var yRow0 = dst + pair * 2 * dstWidth;
                WriteRows(r0, g0, b0, r1, g1, b1, yRow0, yRow0 + dstWidth, uvPlane + pair * dstWidth, dstWidth);
            });
        }
    }

    private static unsafe void ConvertSameSize(byte[] bgra, int width, int height, byte[] nv12)
    {
        fixed (byte* srcPtr = bgra)
        fixed (byte* dstPtr = nv12)
        {
            var src = srcPtr;
            var dst = dstPtr;
            var stride = width * 4;
            var uvPlane = dst + width * height;

            Parallel.For(0, height / 2, pair =>
            {
                var y0 = pair * 2;
                var row0 = src + (long)y0 * stride;
                var row1 = row0 + stride;
                var yRow0 = dst + y0 * width;
                var yRow1 = yRow0 + width;
                var uvRow = uvPlane + pair * width;
                var x = 0;
                // 8픽셀씩: BGRA에서 B·G·R을 16비트로 뽑아 계산
                for (; x + 8 <= width; x += 8)
                {
                    var (r0, g0, b0) = Channels(row0 + x * 4);
                    var (r1, g1, b1) = Channels(row1 + x * 4);
                    Write8(r0, g0, b0, r1, g1, b1, yRow0 + x, yRow1 + x, uvRow + x);
                }
                for (; x < width; x += 2)
                {
                    var p00 = row0 + x * 4;
                    var p01 = p00 + 4;
                    var p10 = row1 + x * 4;
                    var p11 = p10 + 4;
                    yRow0[x] = Luma(p00[2], p00[1], p00[0]);
                    yRow0[x + 1] = Luma(p01[2], p01[1], p01[0]);
                    yRow1[x] = Luma(p10[2], p10[1], p10[0]);
                    yRow1[x + 1] = Luma(p11[2], p11[1], p11[0]);
                    var r = (p00[2] + p01[2] + p10[2] + p11[2] + 2) >> 2;
                    var g = (p00[1] + p01[1] + p10[1] + p11[1] + 2) >> 2;
                    var b = (p00[0] + p01[0] + p10[0] + p11[0] + 2) >> 2;
                    uvRow[x] = (byte)(((-26 * r - 87 * g + 113 * b + 128) >> 8) + 128);
                    uvRow[x + 1] = (byte)(((112 * r - 102 * g - 10 * b + 128) >> 8) + 128);
                }
            });
        }
    }

    /// <summary>원본 줄 [sy0, sy1)을 열마다 더해 R·G·B 평면으로 (8픽셀씩, 남은 것은 하나씩). 줄 수는 257 이하 (16비트에 들게)</summary>
    private static unsafe void SumRows(byte* src, int stride, int width, int sy0, int sy1, ushort* r, ushort* g, ushort* b)
    {
        for (var sy = sy0; sy < sy1; sy++)
        {
            var row = src + (long)sy * stride;
            var first = sy == sy0;
            var x = 0;
            for (; x + 8 <= width; x += 8)
            {
                var (cr, cg, cb) = Channels(row + x * 4);
                if (!first)
                {
                    cr += Vector128.Load(r + x);
                    cg += Vector128.Load(g + x);
                    cb += Vector128.Load(b + x);
                }
                cr.Store(r + x);
                cg.Store(g + x);
                cb.Store(b + x);
            }
            for (; x < width; x++)
            {
                var p = row + x * 4;
                r[x] = (ushort)((first ? 0 : r[x]) + p[2]);
                g[x] = (ushort)((first ? 0 : g[x]) + p[1]);
                b[x] = (ushort)((first ? 0 : b[x]) + p[0]);
            }
        }
    }

    /// <summary>평면 R·G·B(두 줄) → Y 두 줄 · UV 한 줄 (8픽셀씩, 남은 것은 하나씩)</summary>
    private static unsafe void WriteRows(ushort* r0, ushort* g0, ushort* b0, ushort* r1, ushort* g1, ushort* b1,
        byte* yRow0, byte* yRow1, byte* uvRow, int width)
    {
        var x = 0;
        for (; x + 8 <= width; x += 8)
            Write8(Vector128.Load(r0 + x), Vector128.Load(g0 + x), Vector128.Load(b0 + x),
                Vector128.Load(r1 + x), Vector128.Load(g1 + x), Vector128.Load(b1 + x), yRow0 + x, yRow1 + x, uvRow + x);
        for (; x < width; x += 2)
        {
            yRow0[x] = Luma(r0[x], g0[x], b0[x]);
            yRow0[x + 1] = Luma(r0[x + 1], g0[x + 1], b0[x + 1]);
            yRow1[x] = Luma(r1[x], g1[x], b1[x]);
            yRow1[x + 1] = Luma(r1[x + 1], g1[x + 1], b1[x + 1]);
            var r = (r0[x] + r0[x + 1] + r1[x] + r1[x + 1] + 2) >> 2;
            var g = (g0[x] + g0[x + 1] + g1[x] + g1[x + 1] + 2) >> 2;
            var b = (b0[x] + b0[x + 1] + b1[x] + b1[x + 1] + 2) >> 2;
            uvRow[x] = (byte)(((-26 * r - 87 * g + 113 * b + 128) >> 8) + 128);
            uvRow[x + 1] = (byte)(((112 * r - 102 * g - 10 * b + 128) >> 8) + 128);
        }
    }

    /// <summary>BGRA 8픽셀 → R·G·B 16비트 8개씩</summary>
    private static unsafe (Vector128<ushort> R, Vector128<ushort> G, Vector128<ushort> B) Channels(byte* p)
    {
        var a = Vector128.Load(p);
        var b = Vector128.Load(p + 16);
        var blue = Vector128.Shuffle(a, PickB0) | Vector128.Shuffle(b, PickB1);
        var green = Vector128.Shuffle(a, PickG0) | Vector128.Shuffle(b, PickG1);
        var red = Vector128.Shuffle(a, PickR0) | Vector128.Shuffle(b, PickR1);
        return (Vector128.WidenLower(red), Vector128.WidenLower(green), Vector128.WidenLower(blue));
    }

    /// <summary>
    /// 두 줄 8픽셀씩의 R·G·B → Y 8개씩(두 줄) · UV 4쌍. 픽셀 하나씩 하는 계산(Luma·UV)과 같은 값:
    /// Y = (47R+157G+16B+128)>>8 + 16 (16비트 부호 없이 넘치지 않음), U·V는 2×2 평균으로 32비트에서
    /// </summary>
    private static unsafe void Write8(Vector128<ushort> r0, Vector128<ushort> g0, Vector128<ushort> b0,
        Vector128<ushort> r1, Vector128<ushort> g1, Vector128<ushort> b1, byte* yRow0, byte* yRow1, byte* uv)
    {
        var round = Vector128.Create((ushort)128);
        var offset = Vector128.Create((ushort)16);
        var y0 = ((r0 * 47 + g0 * 157 + b0 * 16 + round) >>> 8) + offset;
        var y1 = ((r1 * 47 + g1 * 157 + b1 * 16 + round) >>> 8) + offset;
        // Narrow는 두 줄을 이어 16바이트로 만든다 → 앞 8바이트는 윗줄, 뒤 8바이트는 아랫줄
        var both = Vector128.Narrow(y0, y1).AsUInt64();
        *(ulong*)yRow0 = both.GetElement(0);
        *(ulong*)yRow1 = both.GetElement(1);

        // 2×2 합: 두 줄을 더한 16비트 8개를 32비트 4개로 보고 아래·위 16비트를 더한다 (이웃한 두 픽셀)
        var mask = Vector128.Create(0xFFFFu);
        var rs = (r0 + r1).AsUInt32();
        var gs = (g0 + g1).AsUInt32();
        var bs = (b0 + b1).AsUInt32();
        var two = Vector128.Create(2u);
        var r = ((rs & mask) + (rs >>> 16) + two >>> 2).AsInt32();
        var g = ((gs & mask) + (gs >>> 16) + two >>> 2).AsInt32();
        var b = ((bs & mask) + (bs >>> 16) + two >>> 2).AsInt32();
        var half = Vector128.Create(128);
        var u = ((r * -26 + g * -87 + b * 113 + half) >> 8) + half;
        var v = ((r * 112 + g * -102 + b * -10 + half) >> 8) + half;
        // U·V를 바이트로 번갈아: 32비트마다 U | V<<8 → 16비트 4개로 줄여 앞 8바이트
        var packed = Vector128.Narrow((u | (v << 8)).AsUInt32(), Vector128<uint>.Zero).AsUInt64();
        *(ulong*)uv = packed.GetElement(0);
    }

    private static byte Luma(int r, int g, int b) => (byte)(((47 * r + 157 * g + 16 * b + 128) >> 8) + 16);
}
