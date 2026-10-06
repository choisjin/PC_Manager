using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.StaticFiles;
using PcManager.Server.Hubs;
using PcManager.Server.Services;
using PcManager.Shared;

namespace PcManager.Server.Api;

/// <summary>
/// 결과 확인 도구(Result·영상·이미지를 맞춰 보기):
///  - 셋 저장·목록·이름 변경·삭제, 저장할 때 테스트 PC의 파일을 서버로 백업 (테스트 PC가 꺼져도 열림)
///  - 영상 자르기는 테스트 PC 에이전트가 ffmpeg로 (결과는 원래 영상 폴더)
/// </summary>
public static class ResultSetEndpoints
{
    private static readonly FileExtensionContentTypeProvider ContentTypes = new();

    // 진행 중인 백업 (셋 id) — 같은 셋을 두 번 백업하지 않게
    private static readonly ConcurrentDictionary<string, byte> Running = new();

    public record CreateResultSetRequest(
        string Name, string AgentId, string? MachineName, string ResultPath, IReadOnlyList<string>? VideoPaths,
        string? ImageDir, bool CopyVideo, JsonElement? Config, IReadOnlyList<string>? Files);

    public record UpdateResultSetRequest(string? Name, JsonElement? Config);

    public record TrimRequest(string Path, double Start, double End);
    public record PrepareRequest(string Path, bool Convert);

    public static void MapResultSetApi(this WebApplication app)
    {
        var api = app.MapGroup("/api/result-sets");

        api.MapGet("/", (ResultSetStore store) => store.List());

        api.MapGet("/{id}", (string id, ResultSetStore store) =>
            store.Get(id) is { } set ? Results.Ok(set) : Results.NotFound());

        // 저장: 셋을 만들고 백업을 백그라운드로 시작 (진행은 GET /{id}의 backup으로 확인)
        api.MapPost("/", (CreateResultSetRequest request, HttpRequest http, ResultSetStore store,
            AgentRegistry registry, IHubContext<AgentHub> agentHub, ILoggerFactory loggers) =>
        {
            if (string.IsNullOrWhiteSpace(request.Name))
                return Results.BadRequest("이름을 입력하세요.");
            if (string.IsNullOrWhiteSpace(request.ResultPath))
                return Results.BadRequest("Result 파일이 없습니다.");
            var files = (request.Files ?? [])
                .Append(request.ResultPath)
                .Concat(request.CopyVideo ? request.VideoPaths ?? [] : [])
                .Where(f => !string.IsNullOrWhiteSpace(f))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var now = DateTime.UtcNow;
            var set = new ResultSet(Guid.NewGuid().ToString("N"), request.Name.Trim(), now, now,
                http.Headers["X-User-Id"].ToString() is { Length: > 0 } user ? user : null,
                request.AgentId, request.MachineName, request.ResultPath, request.VideoPaths ?? [], request.ImageDir,
                request.CopyVideo, request.Config, files, new Dictionary<string, string>(), ResultSetBackup.Pending(files.Count));
            store.Save(set);
            StartBackup(set.Id, files, store, registry, agentHub, loggers.CreateLogger(nameof(ResultSetEndpoints)));
            return Results.Ok(set);
        });

        // 이름·동기화 설정만 바꾼다 (파일은 다시 받지 않음)
        api.MapPut("/{id}", (string id, UpdateResultSetRequest request, ResultSetStore store) =>
        {
            var updated = store.Update(id, s => s with
            {
                Name = string.IsNullOrWhiteSpace(request.Name) ? s.Name : request.Name.Trim(),
                Config = request.Config ?? s.Config,
                UpdatedAt = DateTime.UtcNow,
            });
            return updated is null ? Results.NotFound() : Results.Ok(updated);
        });

        api.MapDelete("/{id}", (string id, ResultSetStore store) =>
            store.Delete(id) ? Results.NoContent() : Results.NotFound());

        // 백업이 실패했을 때(테스트 PC 오프라인 등) 빠진 파일만 다시 받는다
        api.MapPost("/{id}/backup", (string id, ResultSetStore store, AgentRegistry registry, IHubContext<AgentHub> agentHub, ILoggerFactory loggers) =>
        {
            if (store.Get(id) is not { } set)
                return Results.NotFound();
            var missing = MissingFiles(set, store);
            store.Update(id, s => s with { Backup = ResultSetBackup.Pending(missing.Count) });
            StartBackup(id, missing, store, registry, agentHub, loggers.CreateLogger(nameof(ResultSetEndpoints)));
            return Results.Accepted();
        });

        // 백업된 파일 (원래 경로로 찾는다). 영상은 Range 지원
        api.MapGet("/{id}/file", (string id, string path, ResultSetStore store) =>
        {
            if (store.Get(id) is not { } set || !set.Files.TryGetValue(path, out var stored))
                return Results.NotFound();
            var full = Path.Combine(store.FilesDirectory(id), stored);
            if (!File.Exists(full))
                return Results.NotFound();
            var type = ContentTypes.TryGetContentType(path, out var t) ? t : "application/octet-stream";
            return Results.File(full, type, enableRangeProcessing: true);
        });

        // 영상 자르기: 테스트 PC 에이전트가 ffmpeg로 잘라 원래 영상 폴더에 저장
        app.MapPost("/api/agents/{agentId}/video/trim", async (string agentId, TrimRequest request, AgentRegistry registry,
            IHubContext<AgentHub> agentHub, CancellationToken ct) =>
        {
            if (!registry.TryGetConnection(agentId, out var connectionId))
                return Results.Conflict("PC가 오프라인입니다.");
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromMinutes(31));
                var result = await agentHub.Clients.Client(connectionId)
                    .InvokeAsync<VideoTrimResult>(AgentClientMethods.TrimVideo, request.Path, request.Start, request.End, timeout.Token);
                return result.Error is null ? Results.Ok(result) : Results.BadRequest(result.Error);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                return Results.Problem($"에이전트 호출 실패 (에이전트를 업데이트하세요): {ex.Message}", statusCode: StatusCodes.Status502BadGateway);
            }
        });

        // 영상 재생 준비: 길이·fps 읽기, convert면 탐색 가능한 재생용 사본 (테스트 PC 캐시)
        app.MapPost("/api/agents/{agentId}/video/prepare", async (string agentId, PrepareRequest request, AgentRegistry registry,
            IHubContext<AgentHub> agentHub, CancellationToken ct) =>
        {
            if (!registry.TryGetConnection(agentId, out var connectionId))
                return Results.Conflict("PC가 오프라인입니다.");
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromMinutes(61));
                var result = await agentHub.Clients.Client(connectionId)
                    .InvokeAsync<VideoPrepareResult>(AgentClientMethods.PrepareVideo, request.Path, request.Convert, timeout.Token);
                return result.Error is null ? Results.Ok(result) : Results.BadRequest(result.Error);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                return Results.Problem($"에이전트 호출 실패 (에이전트를 업데이트하세요): {ex.Message}", statusCode: StatusCodes.Status502BadGateway);
            }
        });
    }

    private static List<string> MissingFiles(ResultSet set, ResultSetStore store) =>
        set.Requested
            .Where(f => !set.Files.TryGetValue(f, out var stored) || !File.Exists(Path.Combine(store.FilesDirectory(set.Id), stored)))
            .ToList();

    /// <summary>테스트 PC 파일을 셋 폴더로 받는다 (영상 스트리밍과 같은 조각 파이프라인)</summary>
    private static void StartBackup(string id, List<string> files, ResultSetStore store, AgentRegistry registry,
        IHubContext<AgentHub> agentHub, ILogger logger)
    {
        if (!Running.TryAdd(id, 0))
            return;
        _ = Task.Run(async () =>
        {
            var done = 0;
            var skipped = 0;
            long bytes = 0;
            var errors = new List<string>();
            try
            {
                var dir = store.FilesDirectory(id);
                Directory.CreateDirectory(dir);
                var start = store.Get(id)?.Files.Count ?? 0;
                foreach (var (path, index) in files.Select((f, i) => (f, i)))
                {
                    if (store.Get(id) is null)
                        return; // 백업 중 삭제됨
                    if (!registry.TryGetConnection(store.Get(id)!.AgentId, out var connectionId))
                    {
                        errors.Add("테스트 PC가 오프라인입니다");
                        break;
                    }
                    var stored = $"{start + index:D5}_{SafeName(Path.GetFileName(path.Replace('\\', '/')))}";
                    try
                    {
                        await using (var output = File.Create(Path.Combine(dir, stored)))
                            bytes += await AgentFiles.CopyAsync(agentHub.Clients.Client(connectionId), path, output, CancellationToken.None);
                        done++;
                        var copied = bytes;
                        store.Update(id, s => s with
                        {
                            Files = new Dictionary<string, string>(s.Files) { [path] = stored },
                            Backup = s.Backup with { FilesDone = done, BytesDone = copied },
                        });
                    }
                    catch (FileNotFoundException)
                    {
                        // Result에 적혔지만 이 PC에 없는 파일: 건너뛴다
                        File.Delete(Path.Combine(dir, stored));
                        skipped++;
                        var skippedNow = skipped;
                        store.Update(id, s => s with { Backup = s.Backup with { Skipped = skippedNow } });
                    }
                    catch (Exception ex)
                    {
                        File.Delete(Path.Combine(dir, stored));
                        errors.Add($"{Path.GetFileName(path)}: {ex.Message}");
                        logger.LogWarning("결과 셋 백업 실패 {Path}: {Message}", path, ex.Message);
                    }
                }
            }
            finally
            {
                var error = errors.Count == 0 ? null : string.Join(" · ", errors.Take(5)) + (errors.Count > 5 ? $" 외 {errors.Count - 5}건" : "");
                store.Update(id, s => s with { Backup = s.Backup with { State = error is null ? "done" : "failed", Error = error } });
                Running.TryRemove(id, out _);
            }
        });
    }

    private static string SafeName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var cleaned = new string(name.Select(c => invalid.Contains(c) ? '_' : c).ToArray());
        return cleaned.Length == 0 ? "file" : cleaned;
    }
}

/// <summary>에이전트 파일을 조각으로 받는 공통 처리 (영상 스트리밍·결과 셋 백업)</summary>
public static class AgentFiles
{
    private const int ChunkSize = 256 * 1024;
    private const int Pipeline = 4;

    /// <summary>파일 전체를 output으로 받는다. 받은 바이트 수</summary>
    public static async Task<long> CopyAsync(ISingleClientProxy proxy, string path, Stream output, CancellationToken ct)
    {
        var size = await proxy.InvokeAsync<long>(AgentClientMethods.GetFileSize, path, ct);
        if (size < 0)
            throw new FileNotFoundException("파일이 없습니다.", path);
        var inflight = new Queue<Task<byte[]>>();
        long next = 0, written = 0;
        void RequestMore()
        {
            while (inflight.Count < Pipeline && next < size)
            {
                var want = (int)Math.Min(ChunkSize, size - next);
                inflight.Enqueue(proxy.InvokeAsync<byte[]>(AgentClientMethods.ReadFileChunk, path, next, want, ct));
                next += want;
            }
        }
        RequestMore();
        while (inflight.Count > 0)
        {
            var data = await inflight.Dequeue();
            if (data.Length == 0)
                break;
            await output.WriteAsync(data, ct);
            written += data.Length;
            RequestMore();
        }
        return written;
    }
}
