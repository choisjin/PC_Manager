using System.Collections.Concurrent;
using System.IO.Compression;
using System.Net.Http.Headers;
using Microsoft.Extensions.FileSystemGlobbing;
using Microsoft.Extensions.Options;
using PcManager.Shared;

namespace PcManager.Agent;

/// <summary>파일 탐색, 결과 수집, 서버와의 파일 송수신을 담당한다.</summary>
public class FileTransferService(
    OutboundQueue outbound,
    IOptions<AgentOptions> options,
    AgentSettingsStore settings,
    ILogger<FileTransferService> logger)
{
    private const int MaxListEntries = 5000;

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(30) };

    // 완료 보고가 서버에 전달될 때까지 추적 (재등록 시 서버가 실패 처리하지 않게)
    private readonly ConcurrentDictionary<string, byte> _unreported = new();

    public IReadOnlyList<string> UnreportedTransferIds => [.. _unreported.Keys];

    /// <param name="path">비어 있으면 드라이브 목록</param>
    public DirectoryListing ListDirectory(string? path)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                var drives = DriveInfo.GetDrives()
                    .Where(d => d.IsReady)
                    .Select(d => new FileEntry(d.Name, d.RootDirectory.FullName, true, 0, null))
                    .ToList();
                return new DirectoryListing("", null, drives, null);
            }

            var directory = new DirectoryInfo(path);
            var entries = directory
                .EnumerateFileSystemInfos("*", new EnumerationOptions
                {
                    IgnoreInaccessible = true,
                    AttributesToSkip = FileAttributes.System,
                })
                .Select(info => info is FileInfo file
                    ? new FileEntry(file.Name, file.FullName, false, file.Length, file.LastWriteTimeUtc)
                    : new FileEntry(info.Name, info.FullName, true, 0, info.LastWriteTimeUtc))
                .Take(MaxListEntries)
                .OrderByDescending(e => e.IsDirectory)
                .ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();

            // 드라이브 루트의 상위는 드라이브 목록("")
            return new DirectoryListing(directory.FullName, directory.Parent?.FullName ?? "", entries, null);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return new DirectoryListing(path ?? "", null, [], ex.Message);
        }
    }

    // 영상 등 미디어 스트리밍: 서버가 필요한 구간만 요청한다 (파일을 서버로 복사하지 않음)
    private const int MaxChunk = 1024 * 1024;

    /// <returns>파일 크기. 없거나 접근할 수 없으면 -1</returns>
    public long GetFileSize(string path)
    {
        try
        {
            var file = new FileInfo(path);
            return file.Exists ? file.Length : -1;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return -1;
        }
    }

    /// <summary>파일의 [offset, offset+length) 구간을 읽는다. EOF에 걸리면 더 짧게 반환한다.</summary>
    public byte[] ReadFileChunk(string path, long offset, int length)
    {
        if (offset < 0 || length <= 0)
            return [];
        length = Math.Min(length, MaxChunk);

        // 테스트가 아직 쓰고 있는(녹화 중인) 파일도 읽을 수 있게 공유 모드로 연다
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        if (offset >= stream.Length)
            return [];

        stream.Seek(offset, SeekOrigin.Begin);
        var buffer = new byte[Math.Min(length, (int)Math.Min(stream.Length - offset, int.MaxValue))];
        var total = 0;
        while (total < buffer.Length)
        {
            var read = stream.Read(buffer, total, buffer.Length - total);
            if (read == 0)
                break;
            total += read;
        }
        return total == buffer.Length ? buffer : buffer[..total];
    }

    /// <summary>같은 PC 안의 파일 조작 (복사/이동/삭제/폴더 생성/이름 변경)</summary>
    public FileOpResult PerformFileOp(FileOpRequest request)
    {
        try
        {
            switch (request.Op)
            {
                case FileOpKind.Copy:
                {
                    var dest = UniqueChildPath(Require(request.Target, "대상 폴더"), Path.GetFileName(request.Path.TrimEnd('\\', '/')));
                    CopyRecursive(request.Path, dest);
                    return new FileOpResult(true, null, dest);
                }
                case FileOpKind.Move:
                {
                    var dest = UniqueChildPath(Require(request.Target, "대상 폴더"), Path.GetFileName(request.Path.TrimEnd('\\', '/')));
                    MovePath(request.Path, dest);
                    return new FileOpResult(true, null, dest);
                }
                case FileOpKind.Delete:
                    DeletePath(request.Path);
                    return new FileOpResult(true, null, null);
                case FileOpKind.CreateDirectory:
                {
                    var dest = UniqueChildPath(request.Path, Require(request.Target, "폴더 이름"));
                    Directory.CreateDirectory(dest);
                    return new FileOpResult(true, null, dest);
                }
                case FileOpKind.Rename:
                {
                    var parent = Path.GetDirectoryName(request.Path.TrimEnd('\\', '/'))
                        ?? throw new IOException("상위 폴더를 찾을 수 없습니다.");
                    var dest = Path.Combine(parent, CleanName(Require(request.Target, "새 이름")));
                    if (!string.Equals(dest, request.Path, StringComparison.OrdinalIgnoreCase) && Exists(dest))
                        throw new IOException("같은 이름이 이미 있습니다.");
                    MovePath(request.Path, dest);
                    return new FileOpResult(true, null, dest);
                }
                default:
                    return new FileOpResult(false, "지원하지 않는 작업입니다.", null);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            logger.LogWarning("파일 조작 실패 {Op} {Path}: {Message}", request.Op, request.Path, ex.Message);
            return new FileOpResult(false, ex.Message, null);
        }
    }

    /// <summary>서버가 준 원본 파일을 대상 폴더로 저장한다 (PC 간 붙여넣기의 받는 쪽).</summary>
    public async Task<string> ReceiveIntoAsync(string destinationFolder, string fileName, Stream content)
    {
        var dest = UniqueChildPath(destinationFolder, CleanName(fileName));
        Directory.CreateDirectory(destinationFolder);
        await using var file = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None, 81920, useAsync: true);
        await content.CopyToAsync(file);
        return dest;
    }

    // --- PC 간 직접 전송(받는 쪽) 쓰기 세션 ---
    // 서버가 보낸 PC의 조각을 서버 디스크를 거치지 않고 바로 이어붙인다.
    private sealed class WriteSession
    {
        public required string TempPath { get; init; }
        public required string FinalPath { get; init; }
        public required FileStream Stream { get; init; }
    }

    private readonly ConcurrentDictionary<string, WriteSession> _writes = new();

    /// <summary>받을 파일의 임시 파일을 열고 세션 ID를 돌려준다. 최종 경로는 이 시점에 정해진다(충돌 시 자동 번호).</summary>
    public string BeginWrite(string destinationFolder, string fileName)
    {
        Directory.CreateDirectory(destinationFolder);
        var finalPath = UniqueChildPath(destinationFolder, CleanName(fileName));
        var tempPath = finalPath + ".pcm-recv";
        var stream = new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None, 81920, useAsync: true);
        var id = Guid.NewGuid().ToString("N");
        _writes[id] = new WriteSession { TempPath = tempPath, FinalPath = finalPath, Stream = stream };
        return id;
    }

    /// <summary>조각을 순서대로 이어붙인다(서버가 순차로 호출).</summary>
    public async Task<int> WriteChunkAsync(string writeId, byte[] data)
    {
        if (!_writes.TryGetValue(writeId, out var session))
            throw new InvalidOperationException("쓰기 세션이 없습니다.");
        await session.Stream.WriteAsync(data);
        return data.Length;
    }

    /// <summary>다 받은 뒤 임시 파일을 최종 경로로 확정한다.</summary>
    public async Task<string> CommitWriteAsync(string writeId)
    {
        if (!_writes.TryRemove(writeId, out var session))
            throw new InvalidOperationException("쓰기 세션이 없습니다.");
        await session.Stream.FlushAsync();
        await session.Stream.DisposeAsync();
        File.Move(session.TempPath, session.FinalPath, overwrite: false);
        return session.FinalPath;
    }

    /// <summary>실패·취소 시 임시 파일을 정리한다.</summary>
    public async Task<bool> AbortWriteAsync(string writeId)
    {
        if (_writes.TryRemove(writeId, out var session))
        {
            await session.Stream.DisposeAsync();
            try
            {
                if (File.Exists(session.TempPath))
                    File.Delete(session.TempPath);
            }
            catch (IOException)
            {
                // 임시 파일 정리 실패는 무시
            }
        }
        return true;
    }

    private static string Require(string? value, string what) =>
        string.IsNullOrWhiteSpace(value) ? throw new ArgumentException($"{what}이(가) 필요합니다.") : value;

    private static string CleanName(string name)
    {
        var trimmed = name.Trim();
        if (trimmed.Length == 0 || trimmed.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new ArgumentException("이름에 사용할 수 없는 문자가 있습니다.");
        return trimmed;
    }

    private static bool Exists(string path) => File.Exists(path) || Directory.Exists(path);

    /// <summary>대상 폴더 안에서 겹치지 않는 이름을 만든다 ("이름", "이름 (2)"...)</summary>
    private static string UniqueChildPath(string folder, string name)
    {
        var candidate = Path.Combine(folder, name);
        if (!Exists(candidate))
            return candidate;

        var stem = Path.GetFileNameWithoutExtension(name);
        var ext = Path.GetExtension(name);
        for (var i = 2; i < 10000; i++)
        {
            candidate = Path.Combine(folder, $"{stem} ({i}){ext}");
            if (!Exists(candidate))
                return candidate;
        }
        throw new IOException("겹치지 않는 이름을 만들 수 없습니다.");
    }

    private static void CopyRecursive(string source, string dest)
    {
        if (Directory.Exists(source))
        {
            Directory.CreateDirectory(dest);
            foreach (var file in Directory.EnumerateFiles(source))
                File.Copy(file, Path.Combine(dest, Path.GetFileName(file)), overwrite: false);
            foreach (var dir in Directory.EnumerateDirectories(source))
                CopyRecursive(dir, Path.Combine(dest, Path.GetFileName(dir)));
        }
        else if (File.Exists(source))
        {
            File.Copy(source, dest, overwrite: false);
        }
        else
        {
            throw new FileNotFoundException($"원본이 없습니다: {source}");
        }
    }

    private static void MovePath(string source, string dest)
    {
        try
        {
            if (Directory.Exists(source))
                Directory.Move(source, dest);
            else
                File.Move(source, dest);
        }
        catch (IOException)
        {
            // 다른 드라이브 등으로 Move가 안 되면 복사 후 삭제
            CopyRecursive(source, dest);
            DeletePath(source);
        }
    }

    private static void DeletePath(string path)
    {
        if (Directory.Exists(path))
            Directory.Delete(path, recursive: true);
        else if (File.Exists(path))
            File.Delete(path);
        else
            throw new FileNotFoundException($"대상이 없습니다: {path}");
    }

    public void StartCollect(CollectFilesRequest request) =>
        StartTransfer(request.TransferId, progress => CollectAsync(request, progress));

    public void StartUpload(UploadFileRequest request) =>
        StartTransfer(request.TransferId, progress => UploadSingleAsync(request, progress));

    public void StartDownload(DownloadFileRequest request) =>
        StartTransfer(request.TransferId, progress => DownloadAsync(request, progress));

    public void StartCompress(CompressRequest request) =>
        StartTransfer(request.TransferId, progress => CompressAsync(request, progress));

    /// <summary>TransferCompleted가 서버에 전달된 뒤 호출한다.</summary>
    public void MarkReported(string transferId) => _unreported.TryRemove(transferId, out _);

    private void StartTransfer(string transferId, Func<TransferProgress, Task> work)
    {
        if (!_unreported.TryAdd(transferId, 0))
            return; // 중복 요청

        _ = Task.Run(async () =>
        {
            var progress = new TransferProgress();
            string? error = null;
            try
            {
                await work(progress);
            }
            catch (Exception ex)
            {
                error = ex.Message;
                logger.LogWarning(ex, "파일 전송 실패 {TransferId}", transferId);
            }

            outbound.Enqueue(new TransferCompleted(
                transferId, error is null, progress.Files, progress.Bytes, error, DateTime.UtcNow));
        });
    }

    private async Task CollectAsync(CollectFilesRequest request, TransferProgress progress)
    {
        var root = string.IsNullOrWhiteSpace(request.SourceDirectory)
            ? options.Value.GetResultDirectory(request.ResultKey)
            : Path.GetFullPath(request.SourceDirectory);
        if (!Directory.Exists(root))
            throw new DirectoryNotFoundException($"수집할 폴더가 없습니다: {root}");

        var matcher = new Matcher(StringComparison.OrdinalIgnoreCase);
        matcher.AddIncludePatterns(request.Patterns.Count > 0 ? request.Patterns : ["**/*"]);

        foreach (var fullPath in matcher.GetResultsInFullPath(root))
        {
            var relativePath = Path.GetRelativePath(root, fullPath).Replace('\\', '/');
            progress.Bytes += await UploadAsync(request.TransferId, relativePath, fullPath);
            progress.Files++;
        }
        logger.LogInformation("결과 수집 완료 {TransferId}: {Files}개, {Bytes} bytes", request.TransferId, progress.Files, progress.Bytes);
    }

    private async Task UploadSingleAsync(UploadFileRequest request, TransferProgress progress)
    {
        var file = new FileInfo(request.SourcePath);
        if (!file.Exists)
            throw new FileNotFoundException($"파일이 없습니다: {request.SourcePath}");

        progress.Bytes = await UploadAsync(request.TransferId, file.Name, file.FullName);
        progress.Files = 1;
    }

    /// <summary>선택 항목을 대상 폴더에 ZIP으로 압축한다. 진행 상황을 서버로 보고한다.</summary>
    private async Task CompressAsync(CompressRequest request, TransferProgress progress)
    {
        if (request.Paths.Count == 0)
            throw new ArgumentException("압축할 항목이 없습니다.");

        Directory.CreateDirectory(request.DestinationFolder);
        var finalPath = UniqueChildPath(request.DestinationFolder, EnsureZipName(request.ArchiveName));
        var tempPath = finalPath + ".pcm-zip";

        // 압축할 파일 목록과 zip 안에서의 경로를 모은다 (폴더는 하위까지)
        var files = new List<(string Full, string Entry)>();
        foreach (var raw in request.Paths)
        {
            var p = raw.TrimEnd('\\', '/');
            if (Directory.Exists(p))
            {
                var baseName = Path.GetFileName(p);
                foreach (var f in Directory.EnumerateFiles(p, "*", SearchOption.AllDirectories))
                    files.Add((f, baseName + "/" + Path.GetRelativePath(p, f).Replace('\\', '/')));
            }
            else if (File.Exists(p))
            {
                files.Add((p, Path.GetFileName(p)));
            }
            else
            {
                throw new FileNotFoundException($"항목이 없습니다: {p}");
            }
        }

        var totalBytes = files.Sum(f => SafeLength(f.Full));
        long doneBytes = 0;
        var lastPercent = -1;
        var lastReport = DateTime.MinValue;

        async Task WriteEntriesAsync(ZipArchive zip)
        {
            var buffer = new byte[81920];
            foreach (var (full, entryName) in files)
            {
                var entry = zip.CreateEntry(entryName, CompressionLevel.Optimal);
                await using (var entryStream = entry.Open())
                // 테스트가 쓰고 있는 파일도 읽을 수 있게 공유 모드
                await using (var source = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 81920, useAsync: true))
                {
                    int read;
                    while ((read = await source.ReadAsync(buffer)) > 0)
                    {
                        await entryStream.WriteAsync(buffer.AsMemory(0, read));
                        doneBytes += read;
                        var percent = totalBytes > 0 ? (int)(doneBytes * 100 / totalBytes) : 100;
                        var now = DateTime.UtcNow;
                        if (percent != lastPercent && (now - lastReport).TotalMilliseconds >= 250)
                        {
                            lastPercent = percent;
                            lastReport = now;
                            outbound.Enqueue(new TransferProgressReport(request.TransferId, progress.Files, doneBytes, percent));
                        }
                    }
                }
                progress.Files++;
            }
        }

        // 분할 압축: 최소 볼륨 크기 64KB로 제한
        var splitBytes = request.SplitBytes > 0 ? Math.Max(request.SplitBytes, 64 * 1024) : 0;

        if (splitBytes > 0)
        {
            var split = new SplitWriteStream(finalPath, splitBytes);
            try
            {
                await using (split)
                using (var zip = new ZipArchive(split, ZipArchiveMode.Create, leaveOpen: true))
                {
                    await WriteEntriesAsync(zip);
                }

                // 볼륨이 하나뿐이면 .001을 떼고 일반 zip 이름으로 되돌린다
                if (split.Volumes.Count == 1)
                {
                    File.Move(split.Volumes[0], finalPath, overwrite: false);
                    progress.Bytes = new FileInfo(finalPath).Length;
                }
                else
                {
                    progress.Bytes = split.Total;
                }
                logger.LogInformation("분할 압축 완료 {TransferId}: {File} ({Volumes}개 볼륨, {Bytes} bytes)",
                    request.TransferId, finalPath, split.Volumes.Count, progress.Bytes);
            }
            catch
            {
                foreach (var volume in split.Volumes)
                {
                    try
                    {
                        if (File.Exists(volume))
                            File.Delete(volume);
                    }
                    catch (IOException)
                    {
                        // 정리 실패는 무시
                    }
                }
                throw;
            }
            return;
        }

        try
        {
            await using (var zipStream = new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None, 81920, useAsync: true))
            using (var zip = new ZipArchive(zipStream, ZipArchiveMode.Create))
            {
                await WriteEntriesAsync(zip);
            }

            File.Move(tempPath, finalPath, overwrite: false);
            progress.Bytes = new FileInfo(finalPath).Length;
            logger.LogInformation("압축 완료 {TransferId}: {File} ({Files}개, {Bytes} bytes)", request.TransferId, finalPath, progress.Files, progress.Bytes);
        }
        catch
        {
            try
            {
                if (File.Exists(tempPath))
                    File.Delete(tempPath);
            }
            catch (IOException)
            {
                // 임시 파일 정리 실패는 무시
            }
            throw;
        }
    }

    /// <summary>zip 출력을 일정 크기마다 .001, .002… 볼륨 파일로 나눠 기록하는 쓰기 전용 스트림.</summary>
    private sealed class SplitWriteStream(string basePath, long volumeSize) : Stream
    {
        private readonly List<string> _volumes = [];
        private FileStream? _current;
        private long _currentLength;
        private long _total;

        public IReadOnlyList<string> Volumes => _volumes;
        public long Total => _total;

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => _total;
        public override long Position { get => _total; set => throw new NotSupportedException(); }

        public override void Write(byte[] buffer, int offset, int count) => WriteCore(buffer.AsSpan(offset, count));

        public override void Write(ReadOnlySpan<byte> buffer) => WriteCore(buffer);

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            WriteCore(buffer.AsSpan(offset, count));
            return Task.CompletedTask;
        }

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            WriteCore(buffer.Span);
            return ValueTask.CompletedTask;
        }

        private void WriteCore(ReadOnlySpan<byte> data)
        {
            while (!data.IsEmpty)
            {
                if (_current is null || _currentLength >= volumeSize)
                    OpenNextVolume();

                var room = (int)Math.Min(data.Length, volumeSize - _currentLength);
                _current!.Write(data[..room]);
                _currentLength += room;
                _total += room;
                data = data[room..];
            }
        }

        private void OpenNextVolume()
        {
            _current?.Dispose();
            var path = $"{basePath}.{_volumes.Count + 1:D3}";
            _current = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 81920);
            _currentLength = 0;
            _volumes.Add(path);
        }

        public override void Flush() => _current?.Flush();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _current?.Dispose();
                _current = null;
            }
            base.Dispose(disposing);
        }

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }

    private static string EnsureZipName(string name)
    {
        var clean = CleanName(name);
        return clean.EndsWith(".zip", StringComparison.OrdinalIgnoreCase) ? clean : clean + ".zip";
    }

    private static long SafeLength(string path)
    {
        try
        {
            return new FileInfo(path).Length;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }

    private async Task DownloadAsync(DownloadFileRequest request, TransferProgress progress)
    {
        var destination = Path.GetFullPath(request.DestinationPath);
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        var tempPath = destination + ".pcm-download";

        try
        {
            using var contentRequest = CreateRequest(HttpMethod.Get, AgentTransferPaths.Content(request.TransferId));
            using var response = await Http.SendAsync(contentRequest, HttpCompletionOption.ResponseHeadersRead);
            await EnsureSuccessAsync(response);

            await using (var source = await response.Content.ReadAsStreamAsync())
            await using (var target = new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None, 81920, useAsync: true))
            {
                await source.CopyToAsync(target);
            }

            // 다 받은 뒤에 교체해서 중간에 실패해도 기존 파일이 깨지지 않게 한다
            File.Move(tempPath, destination, overwrite: true);
            progress.Files = 1;
            progress.Bytes = new FileInfo(destination).Length;
        }
        finally
        {
            if (File.Exists(tempPath))
                File.Delete(tempPath);
        }
    }

    private async Task<long> UploadAsync(string transferId, string relativePath, string fullPath)
    {
        // 테스트가 아직 쓰고 있는 로그 파일도 읽을 수 있게 공유 모드로 연다
        await using var stream = new FileStream(
            fullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 81920, useAsync: true);
        var length = stream.Length;

        using var content = new StreamContent(stream);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        using var uploadRequest = CreateRequest(
            HttpMethod.Post, $"{AgentTransferPaths.UploadFile(transferId)}?path={Uri.EscapeDataString(relativePath)}");
        uploadRequest.Content = content;
        using var response = await Http.SendAsync(uploadRequest);
        await EnsureSuccessAsync(response);
        return length;
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response)
    {
        if (response.IsSuccessStatusCode)
            return;
        var body = await response.Content.ReadAsStringAsync();
        throw new HttpRequestException($"서버 응답 {(int)response.StatusCode}: {body}");
    }

    /// <summary>현재 연결 설정의 서버 주소로 요청을 만든다 (런처에서 서버를 바꿀 수 있음)</summary>
    private HttpRequestMessage CreateRequest(HttpMethod method, string path)
    {
        var current = settings.Current;
        var request = new HttpRequestMessage(method, new Uri(new Uri(current.ServerUrl), path));
        if (!string.IsNullOrEmpty(current.Token))
            request.Headers.Add(AgentHeaders.Token, current.Token);
        return request;
    }

    private sealed class TransferProgress
    {
        public int Files { get; set; }
        public long Bytes { get; set; }
    }
}
