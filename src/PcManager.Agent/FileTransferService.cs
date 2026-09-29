using System.Collections.Concurrent;
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
