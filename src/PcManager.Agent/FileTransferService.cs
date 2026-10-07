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
    // 영상 스트림: 브라우저가 일시정지하면 몇 분씩 멈춰 있을 수 있어 시간 제한 없이 (끊기면 서버가 연결을 닫는다)
    private static readonly HttpClient MediaHttp = new() { Timeout = Timeout.InfiniteTimeSpan };

    // 완료 보고가 서버에 전달될 때까지 추적 (재등록 시 서버가 실패 처리하지 않게)
    private readonly ConcurrentDictionary<string, byte> _unreported = new();
    // 진행 중인 전송의 취소 (대시보드 진행상황에서 취소)
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _running = new();
    public const string CanceledMessage = "취소했습니다";

    public IReadOnlyList<string> UnreportedTransferIds => [.. _unreported.Keys];

    /// <param name="path">비어 있으면 드라이브 목록</param>
    public DirectoryListing ListDirectory(string? path)
    {
        try
        {
            // Linux: 드라이브가 없으므로 "내 PC" = 루트(/)
            if (string.IsNullOrWhiteSpace(path) && !OperatingSystem.IsWindows())
                path = "/";

            if (string.IsNullOrWhiteSpace(path))
            {
                var drives = DriveInfo.GetDrives()
                    .Where(d => d.IsReady)
                    .Select(d => new FileEntry(d.Name, d.RootDirectory.FullName, true, 0, null))
                    .ToList();
                return new DirectoryListing("", null, drives, null);
            }

            // 압축 파일(또는 그 안의 폴더)이면 압축 안 목록
            if (ArchiveBrowser.TrySplit(path, out var archivePath, out var innerPath))
                return ArchiveBrowser.List(archivePath, innerPath);

            var directory = new DirectoryInfo(path);
            var entries = directory
                .EnumerateFileSystemInfos("*", new EnumerationOptions
                {
                    IgnoreInaccessible = true,
                    AttributesToSkip = FileAttributes.System,
                })
                .Select(info => info is FileInfo file
                    ? new FileEntry(file.Name, file.FullName, false, file.Length, file.LastWriteTimeUtc, (file.Attributes & FileAttributes.Hidden) != 0)
                    : new FileEntry(info.Name, info.FullName, true, 0, info.LastWriteTimeUtc, (info.Attributes & FileAttributes.Hidden) != 0))
                .Take(MaxListEntries)
                .OrderByDescending(e => e.IsDirectory)
                .ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();

            // 드라이브 루트의 상위는 드라이브 목록(""), Linux 루트(/)는 상위 없음
            return new DirectoryListing(directory.FullName,
                directory.Parent?.FullName ?? (OperatingSystem.IsWindows() ? "" : null), entries, null);
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
            var file = new FileInfo(ReadablePath(path));
            return file.Exists ? file.Length : -1;
        }
        catch (IOException ex) when (ex.Message.StartsWith(ArchiveBrowser.PasswordRequiredPrefix, StringComparison.Ordinal))
        {
            // 압축 암호가 필요하다는 것은 서버·대시보드까지 알려야 암호를 물을 수 있다
            throw new Microsoft.AspNetCore.SignalR.HubException(ex.Message);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return -1;
        }
    }

    /// <summary>압축 안 파일 경로면 임시 폴더에 풀어 둔 실제 파일 경로를, 아니면 그대로 돌려준다.</summary>
    private static string ReadablePath(string path) =>
        !File.Exists(path) && ArchiveBrowser.TrySplit(path, out var archivePath, out var innerPath) && innerPath.Length > 0
            ? ArchiveBrowser.ExtractToCache(archivePath, innerPath)
            : path;

    /// <summary>압축 파일 안 경로인지 (압축 파일 자체는 제외)</summary>
    private static bool IsInsideArchive(string path) =>
        !File.Exists(path) && !Directory.Exists(path)
        && ArchiveBrowser.TrySplit(path, out _, out var innerPath) && innerPath.Length > 0;

    /// <summary>파일의 [offset, offset+length) 구간을 읽는다. EOF에 걸리면 더 짧게 반환한다.</summary>
    public byte[] ReadFileChunk(string path, long offset, int length)
    {
        if (offset < 0 || length <= 0)
            return [];
        length = Math.Min(length, MaxChunk);

        // 테스트가 아직 쓰고 있는(녹화 중인) 파일도 읽을 수 있게 공유 모드로 연다
        using var stream = new FileStream(ReadablePath(path), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
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

    /// <summary>root 아래(하위 폴더까지)에서 이름에 query가 든 파일·폴더를 찾는다. 최대 max개·20초까지</summary>
    public DirectoryListing SearchFiles(string root, string query, int max)
    {
        var q = query.Trim();
        if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
            return new DirectoryListing(root, null, [], "폴더를 연 뒤 검색하세요 (드라이브 목록·압축 파일 안은 하위 검색을 할 수 없습니다).");
        if (q.Length == 0)
            return new DirectoryListing(root, null, [], "검색어가 없습니다.");
        max = Math.Clamp(max, 1, 5000);
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            MatchCasing = MatchCasing.CaseInsensitive,
            // 시스템 폴더·바로 가기 폴더(정션)는 건너뛴다 (같은 곳을 맴돌지 않게)
            AttributesToSkip = FileAttributes.System | FileAttributes.ReparsePoint,
        };
        var pattern = q.Contains('*') || q.Contains('?') ? q : $"*{q}*";
        var entries = new List<FileEntry>();
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var truncated = false;
        try
        {
            foreach (var info in new DirectoryInfo(root).EnumerateFileSystemInfos(pattern, options))
            {
                var hidden = (info.Attributes & FileAttributes.Hidden) != 0;
                entries.Add(info is FileInfo file
                    ? new FileEntry(file.Name, file.FullName, false, file.Length, file.LastWriteTimeUtc, hidden)
                    : new FileEntry(info.Name, info.FullName, true, 0, info.LastWriteTimeUtc, hidden));
                if (entries.Count >= max || clock.Elapsed > TimeSpan.FromSeconds(20))
                {
                    truncated = true;
                    break;
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return new DirectoryListing(root, null, entries, ex.Message, Truncated: entries.Count > 0);
        }
        return new DirectoryListing(root, null, entries, null, Truncated: truncated);
    }

    /// <summary>
    /// 브라우저 영상 재생용: 파일 [offset, offset+length) 구간을 HTTP로 서버에 흘려보낸다 (SignalR 조각보다 훨씬 빠름).
    /// 파일을 열 수 있으면 바로 true를 돌려주고 보내기는 뒤에서 한다
    /// </summary>
    public bool StartMediaStream(string streamId, string path, long offset, long length)
    {
        if (offset < 0 || length <= 0)
            return false;
        FileStream file;
        try
        {
            // 녹화 중인 파일도 읽을 수 있게 공유 모드로
            file = new FileStream(ReadablePath(path), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 256 * 1024, useAsync: true);
            file.Seek(offset, SeekOrigin.Begin);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return false;
        }
        _ = Task.Run(() => SendMediaStreamAsync(streamId, file, length));
        return true;
    }

    private async Task SendMediaStreamAsync(string streamId, FileStream file, long length)
    {
        try
        {
            await using (file)
            {
                using var content = new StreamContent(new LimitedReadStream(file, length), 256 * 1024);
                content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
                using var request = CreateRequest(HttpMethod.Post, AgentTransferPaths.MediaStream(streamId));
                request.Content = content;
                using var response = await MediaHttp.SendAsync(request);
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException or ObjectDisposedException)
        {
            // 브라우저가 다른 위치로 넘어가 서버가 연결을 끊은 경우가 대부분 — 무시
        }
    }

    /// <summary>앞에서부터 정해진 바이트만 읽는 스트림 (파일 구간 보내기)</summary>
    private sealed class LimitedReadStream(Stream inner, long remaining) : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer, offset, count).GetAwaiter().GetResult();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (remaining <= 0)
                return 0;
            var read = await inner.ReadAsync(buffer[..(int)Math.Min(buffer.Length, remaining)], cancellationToken);
            remaining -= read;
            return read;
        }
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    /// <summary>같은 PC 안의 파일 조작 (복사/이동/삭제/폴더 생성/이름 변경)</summary>
    public FileOpResult PerformFileOp(FileOpRequest request)
    {
        try
        {
            if (IsInsideArchive(request.Path) || (request.Op == FileOpKind.CreateDirectory && ArchiveBrowser.TrySplit(request.Path, out _, out _)))
            {
                if (request.Op != FileOpKind.Copy)
                    return new FileOpResult(false, "압축 파일 안은 읽기 전용입니다. 필요한 항목을 압축 풀기 하거나 복사해서 쓰세요.", null);
                // 압축 안 항목을 실제 폴더로 복사 = 그 항목만 압축 풀기
                var dest = Require(request.Target, "대상 폴더");
                if (ArchiveBrowser.TrySplit(dest, out _, out _))
                    return new FileOpResult(false, "압축 파일 안에는 붙여넣을 수 없습니다.", null);
                ArchiveBrowser.TrySplit(request.Path, out var archivePath, out var innerPath);
                ArchiveBrowser.Extract(archivePath, [innerPath], dest);
                return new FileOpResult(true, null, null);
            }
            if (request.Op is FileOpKind.Copy or FileOpKind.Move && request.Target is not null
                && ArchiveBrowser.TrySplit(request.Target, out _, out _))
                return new FileOpResult(false, "압축 파일 안에는 붙여넣을 수 없습니다.", null);

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
                    // Linux는 대소문자를 구분하므로 a.txt → A.txt도 다른 이름
                    var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
                    if (!string.Equals(dest, request.Path, comparison) && Exists(dest))
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

    /// <summary>쓰기 세션을 닫고 임시 파일 경로를 돌려준다 (호출한 쪽이 옮긴다).</summary>
    public async Task<string> FinishWriteToTempAsync(string writeId)
    {
        if (!_writes.TryRemove(writeId, out var session))
            throw new InvalidOperationException("쓰기 세션이 없습니다.");
        await session.Stream.FlushAsync();
        await session.Stream.DisposeAsync();
        return session.TempPath;
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
        StartTransfer(request.TransferId, (progress, ct) => CollectAsync(request, progress, ct));

    public void StartUpload(UploadFileRequest request) =>
        StartTransfer(request.TransferId, (progress, ct) => UploadSingleAsync(request, progress, ct));

    public void StartDownload(DownloadFileRequest request) =>
        StartTransfer(request.TransferId, (progress, ct) => DownloadAsync(request, progress, ct));

    public void StartCompress(CompressRequest request) =>
        StartTransfer(request.TransferId, (progress, ct) => CompressAsync(request, progress, ct));

    public void StartExtract(ExtractRequest request) =>
        StartTransfer(request.TransferId, (progress, ct) => Task.Run(() => Extract(request, progress, ct), ct));

    /// <summary>진행 중인 전송 취소 (없으면 무시)</summary>
    public void CancelTransfer(string transferId)
    {
        if (_running.TryGetValue(transferId, out var cts))
        {
            logger.LogInformation("전송 취소 {TransferId}", transferId);
            cts.Cancel();
        }
    }

    /// <summary>압축 안 항목(없으면 전부)을 대상 폴더에 푼다. 진행 상황을 서버로 보고한다.</summary>
    private void Extract(ExtractRequest request, TransferProgress progress, CancellationToken ct)
    {
        var inner = new List<string>();
        foreach (var path in request.EntryPaths)
        {
            if (!ArchiveBrowser.TrySplit(path, out var archivePath, out var innerPath)
                || !string.Equals(archivePath, request.ArchivePath, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException($"압축 파일 안의 항목이 아닙니다: {path}");
            if (innerPath.Length > 0)
                inner.Add(innerPath);
        }
        var (files, bytes) = ArchiveBrowser.Extract(request.ArchivePath, inner, request.DestinationFolder,
            (count, done, percent) =>
            {
                ct.ThrowIfCancellationRequested();
                outbound.Enqueue(new TransferProgressReport(request.TransferId, count, done, percent));
            });
        progress.Files = files;
        progress.Bytes = bytes;
        logger.LogInformation("압축 풀기 완료 {TransferId}: {Archive} → {Dest} ({Files}개)", request.TransferId, request.ArchivePath, request.DestinationFolder, files);
    }

    /// <summary>편집한 파일 저장: 받은 임시 파일로 대상 파일을 바꾼다. 실패하면 오류 문구.</summary>
    public async Task<string?> CommitReplaceAsync(CommitReplaceRequest request)
    {
        if (!_writes.TryRemove(request.WriteId, out var session))
            return "쓰기 세션이 없습니다.";
        await session.Stream.FlushAsync();
        await session.Stream.DisposeAsync();
        try
        {
            if (IsInsideArchive(request.TargetPath))
                throw new IOException("압축 파일 안은 읽기 전용입니다.");
            if (request.Backup && File.Exists(request.TargetPath))
                File.Copy(request.TargetPath, request.TargetPath + ".bak", overwrite: true);
            File.Move(session.TempPath, request.TargetPath, overwrite: true);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            try { File.Delete(session.TempPath); } catch (IOException) { }
            return ex.Message;
        }
    }

    /// <summary>TransferCompleted가 서버에 전달된 뒤 호출한다.</summary>
    public void MarkReported(string transferId) => _unreported.TryRemove(transferId, out _);

    private void StartTransfer(string transferId, Func<TransferProgress, CancellationToken, Task> work)
    {
        if (!_unreported.TryAdd(transferId, 0))
            return; // 중복 요청

        var cts = new CancellationTokenSource();
        _running[transferId] = cts;
        _ = Task.Run(async () =>
        {
            var progress = new TransferProgress();
            string? error = null;
            try
            {
                await work(progress, cts.Token);
            }
            catch (Exception ex) when (cts.IsCancellationRequested)
            {
                error = CanceledMessage;
                logger.LogInformation("파일 전송 취소됨 {TransferId} ({Type})", transferId, ex.GetType().Name);
            }
            catch (Exception ex)
            {
                error = ex.Message;
                logger.LogWarning(ex, "파일 전송 실패 {TransferId}", transferId);
            }
            finally
            {
                _running.TryRemove(transferId, out _);
                cts.Dispose();
            }

            outbound.Enqueue(new TransferCompleted(
                transferId, error is null, progress.Files, progress.Bytes, error, DateTime.UtcNow));
        });
    }

    private async Task CollectAsync(CollectFilesRequest request, TransferProgress progress, CancellationToken ct)
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
            progress.Bytes += await UploadAsync(request.TransferId, relativePath, fullPath, ct);
            progress.Files++;
        }
        logger.LogInformation("결과 수집 완료 {TransferId}: {Files}개, {Bytes} bytes", request.TransferId, progress.Files, progress.Bytes);
    }

    private async Task UploadSingleAsync(UploadFileRequest request, TransferProgress progress, CancellationToken ct)
    {
        var file = new FileInfo(ReadablePath(request.SourcePath));
        if (!file.Exists)
            throw new FileNotFoundException($"파일이 없습니다: {request.SourcePath}");

        // 압축 안 파일은 임시 이름이 아니라 원래 이름으로 올린다
        progress.Bytes = await UploadAsync(request.TransferId, Path.GetFileName(request.SourcePath.TrimEnd('\\', '/')), file.FullName, ct);
        progress.Files = 1;
    }

    /// <summary>선택 항목을 대상 폴더에 압축한다 (zip·7z·tar·tar.gz). 진행 상황을 서버로 보고한다.</summary>
    private async Task CompressAsync(CompressRequest request, TransferProgress progress, CancellationToken ct)
    {
        if (request.Paths.Count == 0)
            throw new ArgumentException("압축할 항목이 없습니다.");

        var format = ArchiveFormats.Normalize(request.Format);
        Directory.CreateDirectory(request.DestinationFolder);
        var finalPath = UniqueChildPath(request.DestinationFolder, ArchiveFormats.EnsureName(CleanName(request.ArchiveName), format));
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
                    while ((read = await source.ReadAsync(buffer, ct)) > 0)
                    {
                        await entryStream.WriteAsync(buffer.AsMemory(0, read), ct);
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

        // zip 말고 다른 형식(7z·tar·tar.gz): 한 파일로 만든 뒤 분할이면 .001, .002…로 나눈다 (7-Zip과 같은 방식)
        if (format != ArchiveFormats.Zip)
        {
            try
            {
                await using (var output = new FileStream(tempPath, FileMode.Create, FileAccess.ReadWrite, FileShare.None, 81920))
                {
                    ArchiveFormats.Write(output, format, files, () => progress.Files++, read =>
                    {
                        ct.ThrowIfCancellationRequested();
                        doneBytes += read;
                        var percent = totalBytes > 0 ? (int)(doneBytes * 100 / totalBytes) : 100;
                        var now = DateTime.UtcNow;
                        if (percent != lastPercent && (now - lastReport).TotalMilliseconds >= 250)
                        {
                            lastPercent = percent;
                            lastReport = now;
                            outbound.Enqueue(new TransferProgressReport(request.TransferId, progress.Files, doneBytes, percent));
                        }
                    });
                }
                if (splitBytes > 0 && new FileInfo(tempPath).Length > splitBytes)
                {
                    var volumes = await ArchiveFormats.SplitAsync(tempPath, finalPath, splitBytes, ct);
                    File.Delete(tempPath);
                    progress.Bytes = volumes.Sum(v => new FileInfo(v).Length);
                }
                else
                {
                    File.Move(tempPath, finalPath, overwrite: false);
                    progress.Bytes = new FileInfo(finalPath).Length;
                }
                logger.LogInformation("압축 완료 ({Format}) {TransferId}: {File} ({Files}개, {Bytes} bytes)", format, request.TransferId, finalPath, progress.Files, progress.Bytes);
            }
            catch
            {
                ArchiveFormats.DeleteQuietly(tempPath);
                for (var i = 1; i < 10000 && File.Exists($"{finalPath}.{i:000}"); i++)
                    ArchiveFormats.DeleteQuietly($"{finalPath}.{i:000}");
                throw;
            }
            return;
        }

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

    private async Task DownloadAsync(DownloadFileRequest request, TransferProgress progress, CancellationToken ct)
    {
        var destination = Path.GetFullPath(request.DestinationPath);
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        var tempPath = destination + ".pcm-download";

        try
        {
            using var contentRequest = CreateRequest(HttpMethod.Get, AgentTransferPaths.Content(request.TransferId));
            using var response = await Http.SendAsync(contentRequest, HttpCompletionOption.ResponseHeadersRead, ct);
            await EnsureSuccessAsync(response);

            await using (var source = await response.Content.ReadAsStreamAsync(ct))
            await using (var target = new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None, 81920, useAsync: true))
            {
                await source.CopyToAsync(target, ct);
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

    private async Task<long> UploadAsync(string transferId, string relativePath, string fullPath, CancellationToken ct)
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
        using var response = await Http.SendAsync(uploadRequest, ct);
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
