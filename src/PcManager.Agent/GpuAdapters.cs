using System.Runtime.CompilerServices;
using SharpGen.Runtime;
using Vortice.DXGI;

namespace PcManager.Agent;

/// <summary>
/// 영상 처리에 쓸 GPU (Windows, DXGI): 가상 디스플레이(StarDesk·Parsec 등 간접 디스플레이)와 기본 렌더러(소프트웨어)는 빼고
/// NVIDIA·AMD·Intel 장치만, 외장 → 내장 차례 (전용 메모리가 큰 쪽이 외장). 어셈블리를 불러올 때 FfmpegGpu에 넣는다
/// (서비스·원격조작 세션 어느 프로세스든)
/// </summary>
internal static class GpuAdapters
{
    private static readonly uint[] Vendors = [0x10DE, 0x1002, 0x1022, 0x8086];

    [ModuleInitializer]
    internal static void Register() => FfmpegGpu.FindAdapters = Find;

    public static IReadOnlyList<FfmpegGpu.Adapter> Find()
    {
        var list = new List<FfmpegGpu.Adapter>();
        var seen = new HashSet<(uint, uint, string)>();
        try
        {
            using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
            for (uint i = 0; factory.EnumAdapters1(i, out var adapter).Success; i++)
            {
                using (adapter)
                {
                    var d = adapter.Description1;
                    // 같은 GPU가 여러 번 나오기도 한다 (가상 디스플레이가 실제 GPU 이름으로 붙는 경우 등) → 첫 번째만
                    if ((d.Flags & AdapterFlags.Software) != 0 || !Vendors.Contains(d.VendorId) || !seen.Add((d.VendorId, d.DeviceId, d.Description.Trim())))
                        continue;
                    list.Add(new FfmpegGpu.Adapter((int)i, d.Description.Trim(), d.VendorId, (long)(ulong)(nuint)d.DedicatedVideoMemory));
                }
            }
        }
        catch (Exception ex) when (ex is SharpGenException or DllNotFoundException or EntryPointNotFoundException or OverflowException)
        {
            // DXGI가 없는 환경 등: 찾은 데까지
        }
        // 외장(전용 메모리 큼) → 내장. 같으면 DXGI 차례
        return list.OrderByDescending(a => a.DedicatedMemory).ThenBy(a => a.Index).ToList();
    }
}
