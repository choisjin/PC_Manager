namespace PcManager.Agent.Remote;

/// <summary>
/// BGRA → NV12 (BT.709, 제한 범위) 변환. 원본을 임의의 더 작은 크기로 줄이며 변환한다
/// (대시보드 PC 해상도에 맞춰 스트림 크기를 정하기 위해). 같은 크기면 1:1, 줄일 때는 영역 평균(박스 필터)으로
/// 글자가 깨지지 않게 한다. 행 두 줄 단위로 여러 코어에서 처리한다.
/// </summary>
internal static class Nv12Converter
{
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

        fixed (byte* srcPtr = bgra)
        fixed (byte* dstPtr = nv12)
        fixed (int* xsPtr = xs)
        {
            var src = srcPtr;
            var dst = dstPtr;
            var xmap = xsPtr;
            var srcStride = srcWidth * 4;
            var uvPlane = dst + dstWidth * dstHeight;

            Parallel.For(0, dstHeight / 2, pair =>
            {
                // 출력 두 줄(y0, y0+1)의 RGB 평균을 먼저 구한 뒤 Y와 UV를 만든다
                var rgb = stackalloc int[dstWidth * 2 * 3];
                for (var row = 0; row < 2; row++)
                {
                    var y = pair * 2 + row;
                    var sy0 = (int)((long)y * srcHeight / dstHeight);
                    var sy1 = Math.Max(sy0 + 1, (int)((long)(y + 1) * srcHeight / dstHeight));
                    var acc = rgb + row * dstWidth * 3;
                    for (var x = 0; x < dstWidth; x++)
                    {
                        var sx0 = xmap[x];
                        var sx1 = Math.Max(sx0 + 1, xmap[x + 1]);
                        int r = 0, g = 0, b = 0;
                        for (var sy = sy0; sy < sy1; sy++)
                        {
                            var p = src + (long)sy * srcStride + sx0 * 4;
                            for (var sx = sx0; sx < sx1; sx++, p += 4)
                            {
                                b += p[0];
                                g += p[1];
                                r += p[2];
                            }
                        }
                        var n = (sx1 - sx0) * (sy1 - sy0);
                        acc[x * 3] = (r + n / 2) / n;
                        acc[x * 3 + 1] = (g + n / 2) / n;
                        acc[x * 3 + 2] = (b + n / 2) / n;
                    }
                }

                var yRow0 = dst + pair * 2 * dstWidth;
                var yRow1 = yRow0 + dstWidth;
                var uvRow = uvPlane + pair * dstWidth;
                var top = rgb;
                var bottom = rgb + dstWidth * 3;
                for (var x = 0; x < dstWidth; x += 2)
                {
                    yRow0[x] = Luma(top[x * 3], top[x * 3 + 1], top[x * 3 + 2]);
                    yRow0[x + 1] = Luma(top[x * 3 + 3], top[x * 3 + 4], top[x * 3 + 5]);
                    yRow1[x] = Luma(bottom[x * 3], bottom[x * 3 + 1], bottom[x * 3 + 2]);
                    yRow1[x + 1] = Luma(bottom[x * 3 + 3], bottom[x * 3 + 4], bottom[x * 3 + 5]);

                    var r = (top[x * 3] + top[x * 3 + 3] + bottom[x * 3] + bottom[x * 3 + 3] + 2) >> 2;
                    var g = (top[x * 3 + 1] + top[x * 3 + 4] + bottom[x * 3 + 1] + bottom[x * 3 + 4] + 2) >> 2;
                    var b = (top[x * 3 + 2] + top[x * 3 + 5] + bottom[x * 3 + 2] + bottom[x * 3 + 5] + 2) >> 2;
                    uvRow[x] = (byte)(((-26 * r - 87 * g + 113 * b + 128) >> 8) + 128);
                    uvRow[x + 1] = (byte)(((112 * r - 102 * g - 10 * b + 128) >> 8) + 128);
                }
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
                for (var x = 0; x < width; x += 2)
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

    private static byte Luma(int r, int g, int b) => (byte)(((47 * r + 157 * g + 16 * b + 128) >> 8) + 16);
}
