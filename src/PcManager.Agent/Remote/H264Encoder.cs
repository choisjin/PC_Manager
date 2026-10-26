using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using SharpGen.Runtime;
using Vortice.MediaFoundation;

namespace PcManager.Agent.Remote;

/// <summary>
/// Media Foundation H.264 인코더. NV12 프레임을 넣으면 Annex B 바이트 스트림을 돌려준다.
/// 저지연 모드 + B 프레임 없음 → 프레임 하나 넣으면 바로 하나 나온다.
/// 하드웨어 인코더(GPU: NVIDIA·Intel·AMD — 비동기 MFT)를 먼저 쓰고, 없거나 설정·인코딩이 실패하면 소프트웨어 인코더(동기 MFT)로 바꾼다
/// (하드웨어가 실패한 뒤로는 이 에이전트가 끝날 때까지 소프트웨어만). 비동기 MFT의 이벤트는 전용 스레드가 받아 큐에 넣고,
/// Encode는 입력 자리(NeedInput)를 기다려 넣은 뒤 그 프레임의 출력(HaveOutput)을 잠깐 기다려 받는다 — 동기 MFT와 같은 모양으로
/// </summary>
internal sealed class H264Encoder : IDisposable
{
    private const int NeedMoreInput = unchecked((int)0xC00D6D72);
    private const int StreamChange = unchecked((int)0xC00D6D61);
    private const int ProfileBaseline = 66;
    private const uint EnumSyncMft = 0x1;
    private const uint EnumHardware = 0x4;
    private const uint EnumSortAndFilter = 0x40;
    // 하드웨어 인코더: 입력 자리를 기다리는 최대 시간 (넘으면 고장으로 보고 소프트웨어로) · 넣은 프레임의 출력을 기다리는 시간
    private static readonly TimeSpan InputTimeout = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan OutputWait = TimeSpan.FromMilliseconds(100);

    private static readonly Guid AVLowLatencyMode = new("9c27891a-ed7a-40e1-88e8-b22727a024ee");
    private static readonly Guid AVEncCommonRateControlMode = new("1c0608e9-370c-4710-8a58-cb6181c42423");
    private static readonly Guid AVEncCommonMeanBitRate = new("f7222374-2144-4815-b550-a37f8e12ee52");
    private static readonly Guid AVEncCommonQualityVsSpeed = new("98332df8-03cd-476b-89fa-3f9e442dec9f");
    private static readonly Guid AVEncMPVDefaultBPictureCount = new("8d390aac-dc5c-4200-b57f-814d04babab2");
    private static readonly Guid AVEncMPVGOPSize = new("95f31b26-95a4-41aa-9303-246a7fc6eef1");
    private static readonly Guid AVEncVideoForceKeyFrame = new("398c1b98-8353-475a-9ef2-8f265d260345");

    private static int _startupCount;
    // 하드웨어 인코더가 실패한 적이 있다 → 앞으로 소프트웨어만
    private static volatile bool _hardwareBroken;

    private readonly int _fps;
    private int _bitrate;
    private readonly int _frameBytes;
    private readonly long _frameDuration;
    private IMFTransform _transform = null!;
    private bool _providesSamples;
    private int _outputSize;
    private byte[]? _sequenceHeader;

    // 비동기(하드웨어) MFT: 이벤트 받는 스레드 · 받은 이벤트 · 남은 입력 자리 수
    private IMFMediaEventGenerator? _events;
    private Thread? _pump;
    private BlockingCollection<MediaEventTypes>? _queue;
    private int _needInput;

    public int Width { get; }
    public int Height { get; }
    public string Name { get; private set; } = "";

    /// <summary>하드웨어(GPU) 인코더인지</summary>
    public bool Hardware => _events is not null;

    /// <summary>이 PC의 하드웨어 H.264 인코더 (제조사, PC 정보 표시용 — 처음 한 번만 찾는다)</summary>
    public static IReadOnlyList<string> HardwareEncoders => HardwareList.Value;

    /// <summary>하드웨어 인코더가 실패해 소프트웨어만 쓰는 중</summary>
    public static bool HardwareBroken => _hardwareBroken;

    private static readonly Lazy<IReadOnlyList<string>> HardwareList = new(FindHardware);

    private static IReadOnlyList<string> FindHardware()
    {
        if (Interlocked.Increment(ref _startupCount) == 1)
            MediaFactory.MFStartup(true).CheckError();
        try
        {
            using var activates = MediaFactory.MFTEnumEx(TransformCategoryGuids.VideoEncoder, EnumHardware | EnumSortAndFilter,
                new RegisterTypeInfo { GuidMajorType = MediaTypeGuids.Video, GuidSubtype = VideoFormatGuids.NV12 },
                new RegisterTypeInfo { GuidMajorType = MediaTypeGuids.Video, GuidSubtype = VideoFormatGuids.H264 });
            var list = new List<string>();
            foreach (var activate in activates)
            {
                string? vendor = null;
                try
                {
                    vendor = activate.GetString(TransformAttributeKeys.MftEnumHardwareVendorIdAttribute);
                }
                catch (SharpGenException)
                {
                    // 제조사를 모름
                }
                list.Add(VendorName(vendor) ?? (string.IsNullOrEmpty(activate.FriendlyName) ? "하드웨어 인코더" : activate.FriendlyName));
            }
            return list.Distinct().ToList();
        }
        catch (SharpGenException)
        {
            return [];
        }
        finally
        {
            Shutdown();
        }
    }

    /// <summary>VEN_10DE 같은 PCI 제조사 id → 이름</summary>
    private static string? VendorName(string? id) => id?.ToUpperInvariant() switch
    {
        { } v when v.Contains("10DE") => "NVIDIA",
        { } v when v.Contains("8086") => "Intel",
        { } v when v.Contains("1002") || v.Contains("1022") => "AMD",
        _ => null,
    };

    public H264Encoder(int width, int height, int fps, int bitrate)
    {
        if (width % 2 != 0 || height % 2 != 0)
            throw new ArgumentException("H.264 프레임 크기는 짝수여야 합니다.");
        Width = width;
        Height = height;
        _fps = fps;
        _bitrate = bitrate;
        _frameBytes = width * height * 3 / 2;
        _frameDuration = 10_000_000L / fps;

        if (Interlocked.Increment(ref _startupCount) == 1)
            MediaFactory.MFStartup(true).CheckError();
        try
        {
            if (!_hardwareBroken && TryOpen(hardware: true))
                return;
            if (!TryOpen(hardware: false))
                throw new InvalidOperationException("H.264 인코더를 찾지 못했습니다. (Windows N 에디션이면 미디어 기능 팩이 필요합니다)");
        }
        catch
        {
            Shutdown();
            throw;
        }
    }

    /// <summary>하드웨어 또는 소프트웨어 인코더를 찾아 설정한다 (후보를 차례로, 설정이 안 되면 다음 후보)</summary>
    private bool TryOpen(bool hardware)
    {
        using var activates = MediaFactory.MFTEnumEx(TransformCategoryGuids.VideoEncoder, (hardware ? EnumHardware : EnumSyncMft) | EnumSortAndFilter,
            new RegisterTypeInfo { GuidMajorType = MediaTypeGuids.Video, GuidSubtype = VideoFormatGuids.NV12 },
            new RegisterTypeInfo { GuidMajorType = MediaTypeGuids.Video, GuidSubtype = VideoFormatGuids.H264 });
        foreach (var activate in activates)
        {
            try
            {
                var name = string.IsNullOrEmpty(activate.FriendlyName) ? "H.264 Encoder" : activate.FriendlyName;
                _transform = activate.ActivateObject<IMFTransform>();
                Configure(hardware);
                Name = hardware ? $"{name} (GPU)" : name;
                return true;
            }
            catch (Exception ex) when (ex is SharpGenException or InvalidOperationException)
            {
                Trace.WriteLine($"H.264 인코더 설정 실패 ({(hardware ? "하드웨어" : "소프트웨어")}): {ex.Message}");
                CloseTransform();
            }
        }
        return false;
    }

    private void Configure(bool hardware)
    {
        if (hardware)
        {
            // 비동기 MFT는 잠금을 풀어야 쓸 수 있고, 입력·출력 차례는 이벤트로 알려 준다
            using var attributes = _transform.Attributes;
            if (attributes.GetUInt32(TransformAttributeKeys.TransformAsync) == 0)
                throw new InvalidOperationException("비동기 MFT가 아닙니다");
            attributes.Set(TransformAttributeKeys.TransformAsyncUnlock, 1u);
            _events = _transform.QueryInterface<IMFMediaEventGenerator>();
        }

        // 형식 지정 전에 넣어야 하는 설정 (지원 안 하는 값은 무시)
        CodecApi.SetBool(_transform, AVLowLatencyMode, true);
        CodecApi.SetUInt32(_transform, AVEncCommonRateControlMode, 0); // CBR
        CodecApi.SetUInt32(_transform, AVEncCommonMeanBitRate, (uint)_bitrate);
        CodecApi.SetUInt32(_transform, AVEncCommonQualityVsSpeed, 0); // 속도 우선
        CodecApi.SetUInt32(_transform, AVEncMPVDefaultBPictureCount, 0);
        CodecApi.SetUInt32(_transform, AVEncMPVGOPSize, (uint)(_fps * 10));

        using (var output = MediaFactory.MFCreateMediaType())
        {
            output.Set(MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Video);
            output.Set(MediaTypeAttributeKeys.Subtype, VideoFormatGuids.H264);
            output.Set(MediaTypeAttributeKeys.AvgBitrate, (uint)_bitrate);
            output.Set(MediaTypeAttributeKeys.FrameSize, MediaFactory.PackSize((uint)Width, (uint)Height));
            output.Set(MediaTypeAttributeKeys.FrameRate, MediaFactory.PackRatio(_fps, 1));
            output.Set(MediaTypeAttributeKeys.PixelAspectRatio, MediaFactory.PackRatio(1, 1));
            output.Set(MediaTypeAttributeKeys.InterlaceMode, (uint)VideoInterlaceMode.Progressive);
            output.Set(MediaTypeAttributeKeys.Mpeg2Profile, (uint)ProfileBaseline);
            _transform.SetOutputType(0, output, 0);
        }

        using (var input = MediaFactory.MFCreateMediaType())
        {
            input.Set(MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Video);
            input.Set(MediaTypeAttributeKeys.Subtype, VideoFormatGuids.NV12);
            input.Set(MediaTypeAttributeKeys.FrameSize, MediaFactory.PackSize((uint)Width, (uint)Height));
            input.Set(MediaTypeAttributeKeys.FrameRate, MediaFactory.PackRatio(_fps, 1));
            input.Set(MediaTypeAttributeKeys.PixelAspectRatio, MediaFactory.PackRatio(1, 1));
            input.Set(MediaTypeAttributeKeys.InterlaceMode, (uint)VideoInterlaceMode.Progressive);
            _transform.SetInputType(0, input, 0);
        }

        // 일부 설정은 형식 지정 후에야 반영된다
        CodecApi.SetBool(_transform, AVLowLatencyMode, true);
        CodecApi.SetUInt32(_transform, AVEncMPVDefaultBPictureCount, 0);

        _sequenceHeader = ReadSequenceHeader();

        var info = _transform.GetOutputStreamInfo(0);
        _providesSamples = (info.Flags & (int)(OutputStreamInfoFlags.OutputStreamProvidesSamples | OutputStreamInfoFlags.OutputStreamCanProvideSamples)) != 0;
        _outputSize = Math.Max(info.Size, _frameBytes);

        if (_events is not null)
        {
            var events = _events;
            var queue = _queue = new BlockingCollection<MediaEventTypes>();
            _needInput = 0;
            _pump = new Thread(() => PumpEvents(events, queue)) { IsBackground = true, Name = "H264 encoder events" };
            _pump.Start();
        }
        _transform.ProcessMessage(TMessageType.MessageNotifyBeginStreaming, 0);
        _transform.ProcessMessage(TMessageType.MessageNotifyStartOfStream, 0);
    }

    /// <summary>비동기 MFT 이벤트를 받아 큐에 넣는다 (MFT를 끄면 GetEvent가 실패해 끝난다)</summary>
    private static void PumpEvents(IMFMediaEventGenerator events, BlockingCollection<MediaEventTypes> queue)
    {
        try
        {
            while (true)
            {
                using var e = events.GetEvent(0);
                queue.Add(e.Status.Failure ? MediaEventTypes.Error : e.EventType);
            }
        }
        catch (Exception ex) when (ex is SharpGenException or InvalidOperationException)
        {
            // 종료 (MF_E_SHUTDOWN) 또는 큐가 닫힘
        }
        finally
        {
            queue.CompleteAdding();
        }
    }

    /// <summary>비트레이트를 실행 중에 바꾼다 (다음 프레임부터)</summary>
    public void SetBitrate(int bitrate)
    {
        _bitrate = bitrate;
        CodecApi.SetUInt32(_transform, AVEncCommonMeanBitRate, (uint)bitrate);
    }

    /// <param name="nv12">Width*Height*3/2 바이트</param>
    /// <param name="timestamp">100ns 단위</param>
    /// <returns>인코딩된 프레임 (없을 수도 있음)</returns>
    public List<EncodedFrame> Encode(byte[] nv12, long timestamp, bool forceKeyFrame)
    {
        if (_events is null)
            return EncodeSync(nv12, timestamp, forceKeyFrame);
        try
        {
            return EncodeAsync(nv12, timestamp, forceKeyFrame);
        }
        catch (Exception ex) when (ex is SharpGenException or TimeoutException or InvalidOperationException)
        {
            // 하드웨어 인코더 고장 → 소프트웨어로 바꿔 이 프레임부터 다시 (키 프레임으로 시작)
            Trace.WriteLine($"하드웨어 H.264 인코더 실패, 소프트웨어로 바꿉니다: {ex.Message}");
            _hardwareBroken = true;
            CloseTransform();
            if (!TryOpen(hardware: false))
                throw new InvalidOperationException("H.264 인코더를 찾지 못했습니다.", ex);
            return EncodeSync(nv12, timestamp, true);
        }
    }

    private List<EncodedFrame> EncodeSync(byte[] nv12, long timestamp, bool forceKeyFrame)
    {
        PutInput(nv12, timestamp, forceKeyFrame);
        var frames = new List<EncodedFrame>(1);
        while (PullOutput(frames))
        {
        }
        return frames;
    }

    private List<EncodedFrame> EncodeAsync(byte[] nv12, long timestamp, bool forceKeyFrame)
    {
        var frames = new List<EncodedFrame>(1);
        var queue = _queue!;
        // 입력 자리를 기다린다 (그 사이 나온 출력은 받는다)
        var clock = Stopwatch.StartNew();
        while (_needInput == 0)
        {
            var left = InputTimeout - clock.Elapsed;
            if (left <= TimeSpan.Zero || !queue.TryTake(out var type, left))
                throw new TimeoutException("하드웨어 인코더가 입력을 받지 않습니다");
            Handle(type, frames);
        }
        _needInput--;
        PutInput(nv12, timestamp, forceKeyFrame);

        // 넣은 프레임의 출력을 잠깐 기다린다 (저지연이면 곧 나온다). 나오면 이미 와 있는 이벤트만 마저 처리
        var before = frames.Count;
        clock.Restart();
        while (frames.Count == before)
        {
            var left = OutputWait - clock.Elapsed;
            if (left <= TimeSpan.Zero || !queue.TryTake(out var type, left))
                break;
            Handle(type, frames);
        }
        while (queue.TryTake(out var more))
            Handle(more, frames);
        return frames;
    }

    private void Handle(MediaEventTypes type, List<EncodedFrame> frames)
    {
        switch (type)
        {
            case MediaEventTypes.TransformNeedInput:
                _needInput++;
                break;
            case MediaEventTypes.TransformHaveOutput:
                PullOutput(frames);
                break;
            case MediaEventTypes.Error:
                throw new InvalidOperationException("하드웨어 인코더 오류 이벤트");
        }
    }

    private void PutInput(byte[] nv12, long timestamp, bool forceKeyFrame)
    {
        if (forceKeyFrame)
            CodecApi.SetUInt32(_transform, AVEncVideoForceKeyFrame, 1);

        using var buffer = MediaFactory.MFCreateMemoryBuffer(_frameBytes);
        using var sample = MediaFactory.MFCreateSample();
        buffer.Lock(out var ptr, out _, out _);
        try
        {
            Marshal.Copy(nv12, 0, ptr, _frameBytes);
        }
        finally
        {
            buffer.Unlock();
        }
        buffer.CurrentLength = _frameBytes;
        sample.AddBuffer(buffer);
        sample.SampleTime = timestamp;
        sample.SampleDuration = _frameDuration;
        _transform.ProcessInput(0, sample, 0);
    }

    /// <summary>출력 하나를 받아 frames에 넣는다. 받을 게 없으면(NeedMoreInput) false</summary>
    private bool PullOutput(List<EncodedFrame> frames)
    {
        IMFSample? outSample = null;
        IMFMediaBuffer? outBuffer = null;
        if (!_providesSamples)
        {
            outSample = MediaFactory.MFCreateSample();
            outBuffer = MediaFactory.MFCreateMemoryBuffer(_outputSize);
            outSample.AddBuffer(outBuffer);
        }

        var data = new OutputDataBuffer { StreamID = 0, Sample = outSample! };
        try
        {
            var result = _transform.ProcessOutput(ProcessOutputFlags.None, 1, ref data, out _);
            if (result.Code == NeedMoreInput)
                return false;
            if (result.Code == StreamChange)
            {
                // 출력 형식이 바뀌었다고 알려오면 다시 지정한다
                using var type = _transform.GetOutputAvailableType(0, 0);
                _transform.SetOutputType(0, type, 0);
                _sequenceHeader = ReadSequenceHeader();
                return true;
            }
            result.CheckError();

            var produced = data.Sample;
            var isKey = produced.GetUInt32(SampleAttributeKeys.CleanPoint, out var clean).Success && clean != 0;
            using var contiguous = produced.ConvertToContiguousBuffer();
            contiguous.Lock(out var ptr, out _, out var length);
            byte[] bytes;
            try
            {
                bytes = new byte[length];
                Marshal.Copy(ptr, bytes, 0, length);
            }
            finally
            {
                contiguous.Unlock();
            }

            isKey |= H264Bitstream.ContainsNal(bytes, H264Bitstream.NalIdr);
            // 키 프레임에 SPS/PPS가 없으면 앞에 붙여서 브라우저가 바로 디코딩할 수 있게 한다
            if (isKey && _sequenceHeader is { Length: > 0 } header && !H264Bitstream.ContainsNal(bytes, H264Bitstream.NalSps))
                bytes = [.. header, .. bytes];

            frames.Add(new EncodedFrame(bytes, isKey, produced.SampleTime));
            if (_providesSamples)
                produced.Dispose();
            return true;
        }
        finally
        {
            data.Events?.Dispose();
            outBuffer?.Dispose();
            outSample?.Dispose();
        }
    }

    private byte[]? ReadSequenceHeader()
    {
        try
        {
            using var current = _transform.GetOutputCurrentType(0);
            return current.GetBlob(MediaTypeAttributeKeys.MpegSequenceHeader);
        }
        catch (SharpGenException)
        {
            return null;
        }
    }

    /// <summary>지금 MFT를 끝낸다 (비동기면 MFT를 꺼서 이벤트 스레드도 끝낸다)</summary>
    private void CloseTransform()
    {
        if (_transform is null)
            return;
        try
        {
            _transform.ProcessMessage(TMessageType.MessageNotifyEndOfStream, 0);
            _transform.ProcessMessage(TMessageType.MessageNotifyEndStreaming, 0);
        }
        catch (SharpGenException)
        {
            // 종료 중 오류는 무시
        }
        if (_events is not null)
        {
            try
            {
                MediaFactory.MFShutdownObject(_transform);
            }
            catch (SharpGenException)
            {
                // 이미 꺼짐
            }
            _pump?.Join(TimeSpan.FromSeconds(1));
            _events.Dispose();
            _queue?.Dispose();
            _events = null;
            _queue = null;
            _pump = null;
        }
        _transform.Dispose();
        _transform = null!;
    }

    public void Dispose()
    {
        CloseTransform();
        Shutdown();
    }

    private static void Shutdown()
    {
        if (Interlocked.Decrement(ref _startupCount) == 0)
            MediaFactory.MFShutdown();
    }
}

internal readonly record struct EncodedFrame(byte[] Data, bool IsKeyFrame, long Timestamp);

/// <summary>Annex B 바이트 스트림의 NAL 단위 확인</summary>
internal static class H264Bitstream
{
    public const int NalIdr = 5;
    public const int NalSps = 7;

    public static bool ContainsNal(ReadOnlySpan<byte> data, int nalType)
    {
        for (var i = 0; i + 3 < data.Length; i++)
        {
            if (data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 && (data[i + 3] & 0x1F) == nalType)
                return true;
        }
        return false;
    }
}

/// <summary>
/// ICodecAPI 설정. Vortice에 래퍼가 없어서 vtable을 직접 호출한다.
/// (IUnknown 3개 + IsSupported, IsModifiable, GetParameterRange, GetParameterValues, GetDefaultValue, GetValue, SetValue=9)
/// </summary>
internal static unsafe class CodecApi
{
    private static readonly Guid IidCodecApi = new("901db4c7-31ce-41a2-85dc-8fa0bf41b8da");
    private const ushort VtUi4 = 19;
    private const ushort VtBool = 11;

    public static bool SetUInt32(ComObject target, Guid api, uint value) => SetValue(target, api, VtUi4, value);

    public static bool SetBool(ComObject target, Guid api, bool value) => SetValue(target, api, VtBool, value ? 0xFFFFu : 0u);

    private static bool SetValue(ComObject target, Guid api, ushort vt, uint value)
    {
        var iid = IidCodecApi;
        if (Marshal.QueryInterface(target.NativePointer, in iid, out var codec) != 0)
            return false;
        try
        {
            // VARIANT: vt(2) + reserved(6) + 값(8) + 여유(8) = 24바이트 (x64)
            var variant = stackalloc byte[24];
            new Span<byte>(variant, 24).Clear();
            *(ushort*)variant = vt;
            if (vt == VtBool)
                *(short*)(variant + 8) = (short)value;
            else
                *(uint*)(variant + 8) = value;

            var vtable = *(void***)codec;
            var setValue = (delegate* unmanaged[Stdcall]<IntPtr, Guid*, void*, int>)vtable[9];
            return setValue(codec, &api, variant) >= 0;
        }
        finally
        {
            Marshal.Release(codec);
        }
    }
}
