using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.SignalR;
using PcManager.Server.Contracts;
using PcManager.Server.Hubs;
using PcManager.Shared;

namespace PcManager.Server.Services;

/// <summary>
/// 결과 확인 예약 분석을 시각이 되면 시작한다: 고른 영상의 폴더를 다시 읽어 고른 영상 중 가장 먼저 끝난 것(수정 시각) 이후에 저장된
/// 영상까지 모아(사이클마다 나눠 저장하면 그 뒤 사이클 영상, 통으로 저장하면 그 파일만) 수정 시각순으로 에이전트에 영상 분석·이미지 찾기를
/// 시작시키고 결과 확인 작업으로 적는다. PC가 오프라인이면 다시 연결될 때까지 기다린다
/// </summary>
public class ResultScheduler(
    ResultScheduleStore schedules, ResultJobStore jobs, AgentRegistry registry, IHubContext<AgentHub> agentHub,
    IHubContext<DashboardHub, IDashboardClient> dashboard, ILogger<ResultScheduler> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(30);
    private static readonly HashSet<string> VideoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mp4", ".m4v", ".webm", ".ogv", ".mov", ".mkv", ".avi", ".wmv", ".flv", ".ts", ".mpg", ".mpeg", ".m2ts",
    };
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                foreach (var due in schedules.Due(DateTime.UtcNow))
                {
                    if (!registry.TryGetConnection(due.View.AgentId, out var connectionId))
                        continue;
                    await StartAsync(due, agentHub.Clients.Client(connectionId), stoppingToken);
                }
                await Task.Delay(Interval, stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    private async Task StartAsync(ResultScheduleStore.Stored due, ISingleClientProxy proxy, CancellationToken stoppingToken)
    {
        var view = due.View;
        var r = due.Request;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        timeout.CancelAfter(CallTimeout);
        try
        {
            var videos = await CollectVideosAsync(proxy, r.Videos, timeout.Token);
            var starts = videos.Select(p => r.Videos.ToList().FindIndex(v => SamePath(v, p)) is var i and >= 0 && r.Starts is { } s && i < s.Count ? s[i] : 0).ToArray();
            var open = OpenWith(r.Source, videos);
            if (r.Analysis is { } analysis)
            {
                var id = await proxy.InvokeAsync<string>(AgentClientMethods.StartVideoAnalysis, analysis with { Paths = videos, Starts = starts }, timeout.Token);
                var parameters = r.AnalysisParams is { } p && JsonNode.Parse(p.GetRawText()) is JsonObject o ? o : new JsonObject();
                parameters["starts"] = new JsonArray(starts.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray());
                jobs.Register(new RegisterResultJobRequest(id, ResultJobKinds.Analysis, r.AgentId, r.MachineName, r.Title, r.SourceKey, open,
                    JsonSerializer.SerializeToElement(parameters, Json)), view.UserId);
            }
            if (r.Search is { } search)
            {
                var id = await proxy.InvokeAsync<string>(AgentClientMethods.StartImageSearch, search with { Paths = videos, Ranges = null }, timeout.Token);
                jobs.Register(new RegisterResultJobRequest(id, ResultJobKinds.Search, r.AgentId, r.MachineName, r.Title, r.SourceKey, open,
                    r.SearchParams), view.UserId);
            }
            schedules.Update(view.Id, v => v with { State = "started", StartedAt = DateTime.UtcNow, StartedVideos = videos, Error = null });
            logger.LogInformation("예약 분석 시작: {Title} ({Machine}) 영상 {Count}개", view.Title, view.MachineName, videos.Count);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !stoppingToken.IsCancellationRequested)
        {
            logger.LogWarning("예약 분석을 시작하지 못했습니다: {Title} — {Message}", view.Title, ex.Message);
            schedules.Update(view.Id, v => v with { State = "failed", Error = $"시작하지 못했습니다: {ex.Message}" });
        }
        await dashboard.Clients.All.ResultSchedulesChanged(schedules.List());
        await dashboard.Clients.All.ResultJobsChanged(jobs.List());
    }

    /// <summary>
    /// 고른 영상 + 그 폴더들에서 고른 영상 중 가장 이른 수정 시각 이후에 저장된 영상 (같은 테스트의 뒤 사이클 영상, 앞 테스트 영상은 그보다 먼저 끝났다).
    /// 수정 시각순 (같으면 이름순)
    /// </summary>
    private static async Task<List<string>> CollectVideosAsync(ISingleClientProxy proxy, IReadOnlyList<string> chosen, CancellationToken ct)
    {
        var entries = new List<FileEntry>();
        foreach (var folder in chosen.Select(FolderOf).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var listing = await proxy.InvokeAsync<DirectoryListing>(AgentClientMethods.ListDirectory, folder, ct);
            if (listing.Error is null)
                entries.AddRange(listing.Entries.Where(e => !e.IsDirectory && VideoExtensions.Contains(Path.GetExtension(e.Name))));
        }
        var known = entries.Where(e => chosen.Any(c => SamePath(c, e.FullPath))).ToList();
        if (known.Count == 0 || known.Any(e => e.ModifiedAt is null))
            return chosen.ToList();
        var since = known.Min(e => e.ModifiedAt!.Value);
        var picked = entries.Where(e => e.ModifiedAt >= since || chosen.Any(c => SamePath(c, e.FullPath)))
            .OrderBy(e => e.ModifiedAt).ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
            .Select(e => e.FullPath).ToList();
        // 목록에 없던 고른 영상(폴더를 못 읽음 등)도 넣는다
        foreach (var c in chosen)
            if (!picked.Any(p => SamePath(p, c)))
                picked.Add(c);
        return picked;
    }

    /// <summary>결과 확인을 다시 여는 요청: { source: 예약한 Source, 영상 목록만 모은 것으로 }</summary>
    private static JsonElement OpenWith(JsonElement source, IReadOnlyList<string> videos)
    {
        var node = JsonNode.Parse(source.GetRawText()) as JsonObject ?? new JsonObject();
        node["videoPaths"] = new JsonArray(videos.Select(v => (JsonNode?)JsonValue.Create(v)).ToArray());
        return JsonSerializer.SerializeToElement(new JsonObject { ["source"] = node }, Json);
    }

    private static string FolderOf(string path)
    {
        var cut = Math.Max(path.LastIndexOf('\\'), path.LastIndexOf('/'));
        // 드라이브 바로 아래 (C:\a.mp4 → C:\)
        return cut == 2 && path[1] == ':' ? path[..3] : cut > 0 ? path[..cut] : path;
    }

    private static bool SamePath(string a, string b) =>
        string.Equals(a.Replace('/', '\\'), b.Replace('/', '\\'), StringComparison.OrdinalIgnoreCase);
}
