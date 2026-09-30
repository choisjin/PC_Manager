using System.Runtime.InteropServices;
using SharpGen.Runtime;
using Vortice.MediaFoundation;

namespace PcManager.Agent.Remote;

/// <summary>
/// Media Foundation H.264 인코더 (동기 MFT). NV12 프레임을 넣으면 Annex B 바이트 스트림을 돌려준다.
/// 저지연 모드 + B 프레임 없음 → 프레임 하나 넣으면 바로 하나 나온다.
/// </summary>
internal sealed class H264Encoder : IDisposable
{
    private const int NeedMoreInput = unchecked((int)0xC00D6D72);
    private const int StreamChange = unchecked((int)0xC00D6D61);
    private const int ProfileBaseline = 66;

    private static readonly Guid AVLowLatencyMode = new("9c27891a-ed7a-40e1-88e8-b22727a024ee");
    private static readonly Guid AVEncCommonRateControlMode = new("1c0608e9-370c-4710-8a58-cb6181c42423");
    private static readonly Guid AVEncCommonMeanBitRate = new("f7222374-2144-4815-b550-a37f8e12ee52");
    private static readonly Guid AVEncCommonQualityVsSpeed = new("98332df8-03cd-476b-89fa-3f9e442dec9f");
    private static readonly Guid AVEncMPVDefaultBPictureCount = new("8d390aac-dc5c-4200-b57f-814d04babab2");
    private static readonly Guid AVEncMPVGOPSize = new("95f31b26-95a4-41aa-9303-246a7fc6eef1");
    private static readonly Guid AVEncVideoForceKeyFrame = new("398c1b98-8353-475a-9ef2-8f265d260345");

    private static int _startupCount;

    private readonly IMFTransform _transform;
    private readonly int _frameBytes;
    private readonly long _frameDuration;
    private readonly bool _providesSamples;
    private readonly int _outputSize;
    private byte[]? _sequenceHeader;

    public int Width { get; }
    public int Height { get; }
    public string Name { get; }

    public H264Encoder(int width, int height, int fps, int bitrate)
    {
        if (width % 2 != 0 || height % 2 != 0)
            throw new ArgumentException("H.264 프레임 크기는 짝수여야 합니다.");
        Width = width;
        Height = height;
        _frameBytes = width * height * 3 / 2;
        _frameDuration = 10_000_000L / fps;

        if (Interlocked.Increment(ref _startupCount) == 1)
            MediaFactory.MFStartup(true).CheckError();

        _transform = CreateSoftwareEncoder(out var name);
        Name = name;
        try
        {
            // 형식 지정 전에 넣어야 하는 설정 (지원 안 하는 값은 무시)
            CodecApi.SetBool(_transform, AVLowLatencyMode, true);
            CodecApi.SetUInt32(_transform, AVEncCommonRateControlMode, 0); // CBR
            CodecApi.SetUInt32(_transform, AVEncCommonMeanBitRate, (uint)bitrate);
            CodecApi.SetUInt32(_transform, AVEncCommonQualityVsSpeed, 0); // 속도 우선
            CodecApi.SetUInt32(_transform, AVEncMPVDefaultBPictureCount, 0);
            CodecApi.SetUInt32(_transform, AVEncMPVGOPSize, (uint)(fps * 10));

            using (var output = MediaFactory.MFCreateMediaType())
            {
                output.Set(MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Video);
                output.Set(MediaTypeAttributeKeys.Subtype, VideoFormatGuids.H264);
                output.Set(MediaTypeAttributeKeys.AvgBitrate, (uint)bitrate);
                output.Set(MediaTypeAttributeKeys.FrameSize, MediaFactory.PackSize((uint)width, (uint)height));
                output.Set(MediaTypeAttributeKeys.FrameRate, MediaFactory.PackRatio(fps, 1));
                output.Set(MediaTypeAttributeKeys.PixelAspectRatio, MediaFactory.PackRatio(1, 1));
                output.Set(MediaTypeAttributeKeys.InterlaceMode, (uint)VideoInterlaceMode.Progressive);
                output.Set(MediaTypeAttributeKeys.Mpeg2Profile, (uint)ProfileBaseline);
                _transform.SetOutputType(0, output, 0);
            }

            using (var input = MediaFactory.MFCreateMediaType())
            {
                input.Set(MediaTypeAttributeKeys.MajorType, MediaTypeGuids.Video);
                input.Set(MediaTypeAttributeKeys.Subtype, VideoFormatGuids.NV12);
                input.Set(MediaTypeAttributeKeys.FrameSize, MediaFactory.PackSize((uint)width, (uint)height));
                input.Set(MediaTypeAttributeKeys.FrameRate, MediaFactory.PackRatio(fps, 1));
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

            _transform.ProcessMessage(TMessageType.MessageNotifyBeginStreaming, 0);
            _transform.ProcessMessage(TMessageType.MessageNotifyStartOfStream, 0);
        }
        catch
        {
            _transform.Dispose();
            Shutdown();
            throw;
        }
    }

    /// <summary>비트레이트를 실행 중에 바꾼다 (다음 프레임부터)</summary>
    public void SetBitrate(int bitrate) => CodecApi.SetUInt32(_transform, AVEncCommonMeanBitRate, (uint)bitrate);

    /// <param name="nv12">Width*Height*3/2 바이트</param>
    /// <param name="timestamp">100ns 단위</param>
    /// <returns>인코딩된 프레임 (없을 수도 있음)</returns>
    public unsafe List<EncodedFrame> Encode(byte[] nv12, long timestamp, bool forceKeyFrame)
    {
        if (forceKeyFrame)
            CodecApi.SetUInt32(_transform, AVEncVideoForceKeyFrame, 1);

        using (var buffer = MediaFactory.MFCreateMemoryBuffer(_frameBytes))
        using (var sample = MediaFactory.MFCreateSample())
        {
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

        var frames = new List<EncodedFrame>(1);
        while (true)
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
                    break;
                if (result.Code == StreamChange)
                {
                    // 출력 형식이 바뀌었다고 알려오면 다시 지정한다
                    using var type = _transform.GetOutputAvailableType(0, 0);
                    _transform.SetOutputType(0, type, 0);
                    _sequenceHeader = ReadSequenceHeader();
                    continue;
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
            }
            finally
            {
                data.Events?.Dispose();
                outBuffer?.Dispose();
                outSample?.Dispose();
            }
        }
        return frames;
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

    private static IMFTransform CreateSoftwareEncoder(out string name)
    {
        const uint SyncMft = 0x1;
        const uint SortAndFilter = 0x40;

        using var activates = MediaFactory.MFTEnumEx(TransformCategoryGuids.VideoEncoder, SyncMft | SortAndFilter,
            new RegisterTypeInfo { GuidMajorType = MediaTypeGuids.Video, GuidSubtype = VideoFormatGuids.NV12 },
            new RegisterTypeInfo { GuidMajorType = MediaTypeGuids.Video, GuidSubtype = VideoFormatGuids.H264 });

        foreach (var activate in activates)
        {
            try
            {
                name = activate.FriendlyName ?? "H.264 Encoder";
                return activate.ActivateObject<IMFTransform>();
            }
            catch (SharpGenException)
            {
                // 다음 후보
            }
        }
        throw new InvalidOperationException("H.264 인코더를 찾지 못했습니다. (Windows N 에디션이면 미디어 기능 팩이 필요합니다)");
    }

    public void Dispose()
    {
        try
        {
            _transform.ProcessMessage(TMessageType.MessageNotifyEndOfStream, 0);
            _transform.ProcessMessage(TMessageType.MessageNotifyEndStreaming, 0);
        }
        catch (SharpGenException)
        {
            // 종료 중 오류는 무시
        }
        _transform.Dispose();
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
