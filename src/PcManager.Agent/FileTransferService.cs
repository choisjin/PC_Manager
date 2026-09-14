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
