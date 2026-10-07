using SharpCompress.Common;
using SharpCompress.Writers;
using SharpCompress.Writers.SevenZip;
using SharpCompress.Writers.Tar;

namespace PcManager.Agent;

/// <summary>
/// 탐색기 압축 형식. zip은 FileTransferService가 System.IO.Compression으로 만들고(윈도우 탐색기와 같은 방식),
/// 7z·tar·tar.gz는 SharpCompress로 만든다.
/// </summary>
internal static class ArchiveFormats
{
    public const string Zip = "zip";
    public const string SevenZip = "7z";
    public const string Tar = "tar";
    public const string TarGz = "tar.gz";

    public static string Normalize(string? format) => (format ?? "").Trim().TrimStart('.').ToLowerInvariant() switch
    {
        "7z" => SevenZip,
        "tar" => Tar,
        "tar.gz" or "tgz" => TarGz,
        _ => Zip,
    };

    /// <summary>이름이 형식의 확장자로 끝나게 (a → a.7z)</summary>
    public static string EnsureName(string name, string format)
    {
        var ext = "." + format;
        return name.EndsWith(ext, StringComparison.OrdinalIgnoreCase) ? name : name + ext;
    }

    /// <summary>파일들을 output에 압축한다. 파일을 읽을 때마다 bytesRead(읽은 바이트)를 부른다 (진행률·취소)</summary>
    public static void Write(Stream output, string format, IReadOnlyList<(string Full, string Entry)> files, Action fileDone, Action<int> bytesRead)
    {
        using IWriter writer = format switch
        {
            SevenZip => new SevenZipWriter(output, new SevenZipWriterOptions(CompressionType.LZMA) { LeaveStreamOpen = true }),
            TarGz => WriterFactory.OpenWriter(output, ArchiveType.Tar, new TarWriterOptions(CompressionType.GZip, true) { LeaveStreamOpen = true }),
            _ => WriterFactory.OpenWriter(output, ArchiveType.Tar, new TarWriterOptions(CompressionType.None, true) { LeaveStreamOpen = true }),
        };
        foreach (var (full, entry) in files)
        {
            // 테스트가 쓰고 있는 파일도 읽을 수 있게 공유 모드
            using (var source = new ProgressReadStream(
                new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 81920), bytesRead))
            {
                writer.Write(entry, source, File.GetLastWriteTime(full));
            }
            fileDone();
        }
    }

    /// <summary>만든 압축 파일을 일정 크기마다 이름.001, .002…로 나눈다 (7-Zip 분할과 같음 — 이어 붙이면 원래 파일)</summary>
    public static async Task<List<string>> SplitAsync(string sourcePath, string basePath, long volumeSize, CancellationToken ct)
    {
        var volumes = new List<string>();
        var buffer = new byte[81920];
        await using var source = new FileStream(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, useAsync: true);
        while (source.Position < source.Length)
        {
            var path = $"{basePath}.{volumes.Count + 1:000}";
            volumes.Add(path);
            await using var target = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, useAsync: true);
            long written = 0;
            while (written < volumeSize)
            {
                var read = await source.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, volumeSize - written)), ct);
                if (read == 0)
                    break;
                await target.WriteAsync(buffer.AsMemory(0, read), ct);
                written += read;
            }
        }
        return volumes;
    }

    public static void DeleteQuietly(string path)
    {
        try
        {
            if (File.Exists(path))
                File.Delete(path);
        }
        catch (IOException)
        {
            // 정리 실패는 무시
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    /// <summary>읽은 만큼 알려 주는 읽기 스트림 (길이·탐색은 원래 파일 그대로 — 압축기가 파일 크기를 미리 알 수 있게)</summary>
    private sealed class ProgressReadStream(Stream inner, Action<int> onRead) : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => inner.CanSeek;
        public override bool CanWrite => false;
        public override long Length => inner.Length;
        public override long Position { get => inner.Position; set => inner.Position = value; }
        public override void Flush() { }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var read = inner.Read(buffer, offset, count);
            if (read > 0)
                onRead(read);
            return read;
        }

        public override int Read(Span<byte> buffer)
        {
            var read = inner.Read(buffer);
            if (read > 0)
                onRead(read);
            return read;
        }

        public override long Seek(long offset, SeekOrigin origin) => inner.Seek(offset, origin);
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
                inner.Dispose();
            base.Dispose(disposing);
        }
    }
}
