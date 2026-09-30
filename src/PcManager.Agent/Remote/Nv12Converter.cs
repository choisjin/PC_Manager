namespace PcManager.Agent.Remote;

/// <summary>
/// BGRA → NV12 (BT.709, 제한 범위) 변환. scale이 2면 2×2 평균으로 축소한다 (4K 화면 등).
/// 행 두 줄 단위로 나눠 여러 코어에서 처리한다.
/// </summary>
internal static class Nv12Converter
{
    /// <param name="srcWidth">원본 폭 (stride = srcWidth*4)</param>
    /// <param name="dstWidth">출력 폭 (짝수, srcWidth/scale 이하)</param>
    public static unsafe void Convert(byte[] bgra, int srcWidth, byte[] nv12, int dstWidth, int dstHeight, int scale)
    {
        fixed (byte* srcPtr = bgra)
        fixed (byte* dstPtr = nv12)
        {
            var src = srcPtr;
            var dst = dstPtr;
            var srcStride = srcWidth * 4;
            var uvPlane = dst + dstWidth * dstHeight;

            Parallel.For(0, dstHeight / 2, pair =>
            {
                var y0 = pair * 2;
                var yRow0 = dst + y0 * dstWidth;
                var yRow1 = yRow0 + dstWidth;
                var uvRow = uvPlane + pair * dstWidth;

                for (var x = 0; x < dstWidth; x += 2)
                {
                    int r00, g00, b00, r01, g01, b01, r10, g10, b10, r11, g11, b11;
                    Sample(src, srcStride, x, y0, scale, out r00, out g00, out b00);
                    Sample(src, srcStride, x + 1, y0, scale, out r01, out g01, out b01);
                    Sample(src, srcStride, x, y0 + 1, scale, out r10, out g10, out b10);
                    Sample(src, srcStride, x + 1, y0 + 1, scale, out r11, out g11, out b11);

                    yRow0[x] = Luma(r00, g00, b00);
                    yRow0[x + 1] = Luma(r01, g01, b01);
                    yRow1[x] = Luma(r10, g10, b10);
                    yRow1[x + 1] = Luma(r11, g11, b11);

                    var r = (r00 + r01 + r10 + r11 + 2) >> 2;
                    var g = (g00 + g01 + g10 + g11 + 2) >> 2;
                    var b = (b00 + b01 + b10 + b11 + 2) >> 2;
                    uvRow[x] = (byte)(((-26 * r - 87 * g + 113 * b + 128) >> 8) + 128);
                    uvRow[x + 1] = (byte)(((112 * r - 102 * g - 10 * b + 128) >> 8) + 128);
                }
            });
        }
    }

    private static unsafe void Sample(byte* src, int stride, int x, int y, int scale, out int r, out int g, out int b)
    {
        if (scale == 1)
        {
            var p = src + y * stride + x * 4;
            b = p[0];
            g = p[1];
            r = p[2];
            return;
        }

        // 2×2 평균 (scale=2 전용)
        var p0 = src + y * 2 * stride + x * 8;
        var p1 = p0 + stride;
        b = (p0[0] + p0[4] + p1[0] + p1[4] + 2) >> 2;
        g = (p0[1] + p0[5] + p1[1] + p1[5] + 2) >> 2;
        r = (p0[2] + p0[6] + p1[2] + p1[6] + 2) >> 2;
    }

    private static byte Luma(int r, int g, int b) => (byte)(((47 * r + 157 * g + 16 * b + 128) >> 8) + 16);
}
