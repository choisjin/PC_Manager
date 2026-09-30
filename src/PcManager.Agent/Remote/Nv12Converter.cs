namespace PcManager.Agent.Remote;

/// <summary>
/// BGRA → NV12 (BT.709, 제한 범위) 변환. 원본을 임의의 더 작은 크기로 줄이며 변환한다
/// (대시보드 PC 해상도에 맞춰 스트림 크기를 정하기 위해). 최근접 표본화, 행 두 줄 단위로 여러 코어에서 처리한다.
/// </summary>
internal static class Nv12Converter
{
    /// <param name="srcWidth">원본 폭 (stride = srcWidth*4)</param>
    /// <param name="srcHeight">원본 높이</param>
    /// <param name="dstWidth">출력 폭 (짝수, srcWidth 이하)</param>
    /// <param name="dstHeight">출력 높이 (짝수, srcHeight 이하)</param>
    public static unsafe void Convert(byte[] bgra, int srcWidth, int srcHeight, byte[] nv12, int dstWidth, int dstHeight)
    {
        // 열 방향 원본 좌표를 미리 계산한다 (행마다 나눗셈을 반복하지 않도록)
        var xMap = new int[dstWidth];
        for (var x = 0; x < dstWidth; x++)
            xMap[x] = (int)((long)x * srcWidth / dstWidth) * 4;

        fixed (byte* srcPtr = bgra)
        fixed (byte* dstPtr = nv12)
        fixed (int* xMapPtr = xMap)
        {
            var src = srcPtr;
            var dst = dstPtr;
            var xm = xMapPtr;
            var srcStride = srcWidth * 4;
            var uvPlane = dst + dstWidth * dstHeight;

            Parallel.For(0, dstHeight / 2, pair =>
            {
                var y0 = pair * 2;
                var sy0 = (int)((long)y0 * srcHeight / dstHeight);
                var sy1 = (int)((long)(y0 + 1) * srcHeight / dstHeight);
                var srcRow0 = src + (long)sy0 * srcStride;
                var srcRow1 = src + (long)sy1 * srcStride;
                var yRow0 = dst + y0 * dstWidth;
                var yRow1 = yRow0 + dstWidth;
                var uvRow = uvPlane + pair * dstWidth;

                for (var x = 0; x < dstWidth; x += 2)
                {
                    var o0 = xm[x];
                    var o1 = xm[x + 1];
                    var p00 = srcRow0 + o0;
                    var p01 = srcRow0 + o1;
                    var p10 = srcRow1 + o0;
                    var p11 = srcRow1 + o1;

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
