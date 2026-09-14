using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using PcManager.Server.Contracts;
using PcManager.Server.Data;
using PcManager.Server.Hubs;
using PcManager.Shared;

namespace PcManager.Server.Services;

/// <summary>
/// GitHub 릴리스에서 최신 버전과 릴리스노트를 확인하고, 서버 자가 업데이트를 수행한다.
/// </summary>
public class UpdateService
{
    public static Version CurrentVersion { get; } =
        NormalizeVersion(typeof(UpdateService).Assembly.GetName().Version);

    public const string ServerAssetSuffix = ".zip";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly HttpClient _http;
    private readonly ServerOptions _options;
    private readonly AppPaths _paths;
    private readonly IDbContextFactory<AppDbContext> _dbFactory;
    private readonly AgentRegistry _registry;
    private readonly IHubContext<AgentHub, IAgentClient> _agentHub;
    private readonly IHubContext<DashboardHub, IDashboardClient> _dashboard;
    private readonly ILogger<UpdateService> _logger;
    private readonly Lock _lock = new();

    private ReleaseInfo? _latest;
    private DateTime? _checkedAt;
    private string? _checkError;
    private UpdatePhase _serverPhase = UpdatePhase.Idle;
    private string? _serverError;

    public UpdateService(
        IOptions<ServerOptions> options,
        AppPaths paths,
        IDbContextFactory<AppDbContext> dbFactory,
        AgentRegistry registry,
        IHubContext<AgentHub, IAgentClient> agentHub,
        IHubContext<DashboardHub, IDashboardClient> dashboard,
        ILogger<UpdateService> logger)
    {
        _options = options.Value;
        _paths = paths;
        _dbFactory = dbFactory;
        _registry = registry;
        _agentHub = agentHub;
        _dashboard = dashboard;
        _logger = logger;
        _http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("PcManagerServer", CurrentVersion.ToString(3)));
        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
    }

    public UpdateStatusView GetStatus()
    {
        lock (_lock)
        {
            var latest = _latest;
            var available = latest is not null && latest.Version > CurrentVersion;
            return new UpdateStatusView(
                CurrentVersion.ToString(3),
                latest?.Version.ToString(3),
                available,
                latest?.Name,
                latest?.Notes,
                latest?.HtmlUrl,
                latest?.PublishedAt,
                _checkedAt,
                _checkError,
                latest?.ServerAssetUrl is not null,
                _serverPhase,
                _serverError);
        }
    }

    /// <summary>GitHub에서 최신 릴리스를 다시 확인한다.</summary>
    public async Task<UpdateStatusView> CheckAsync(CancellationToken ct = default)
    {
        try
        {
            var url = $"https://api.github.com/repos/{_options.UpdateRepo}/releases/latest";
            using var response = await _http.GetAsync(url, ct);
            response.EnsureSuccessStatusCode();
            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            var release = await JsonSerializer.DeserializeAsync<GitHubRelease>(stream, Json, ct)
                ?? throw new InvalidOperationException("릴리스 응답이 비었습니다.");

            var info = ReleaseInfo.From(release);
            lock (_lock)
            {
                _latest = info;
                _checkedAt = DateTime.UtcNow;
                _checkError = info is null ? "릴리스 버전을 해석할 수 없습니다." : null;
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            lock (_lock)
            {
                _checkedAt = DateTime.UtcNow;
                _checkError = ex.Message;
            }
            _logger.LogWarning("업데이트 확인 실패: {Message}", ex.Message);
        }

        var status = GetStatus();
        await _dashboard.Clients.All.UpdateStatusChanged(status);
        return status;
    }

    /// <summary>온라인이면서 서버보다 구버전인 에이전트에 업데이트 명령을 보낸다.</summary>
    /// <param name="agentIds">null이면 구버전 온라인 에이전트 전체</param>
    public async Task<AgentUpdateResultView> UpdateAgentsAsync(IReadOnlyList<string>? agentIds)
    {
        List<AgentEntity> agents;
        await using (var db = await _dbFactory.CreateDbContextAsync())
        {
            var query = db.Agents.AsNoTracking().AsQueryable();
            if (agentIds is { Count: > 0 })
                query = query.Where(a => agentIds.Contains(a.Id));
            agents = await query.ToListAsync();
        }

        // 대상: 온라인 + (명시 지정이 없으면) 서버보다 구버전
        var targets = agents.Where(a => _registry.IsOnline(a.Id));
        if (agentIds is not { Count: > 0 })
            targets = targets.Where(a => IsOlder(a.AgentVersion));
        var targetList = targets.ToList();

        var dispatched = 0;
        foreach (var agent in targetList)
        {
            if (_registry.TryGetConnection(agent.Id, out var connectionId))
            {
                try
                {
                    // setupUrl은 null → 에이전트가 자신의 서버 주소에서 받는다
                    await _agentHub.Clients.Client(connectionId).UpdateAgent(null);
                    dispatched++;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning("에이전트 업데이트 전송 실패 {AgentId}: {Message}", agent.Id, ex.Message);
                }
            }
        }

        _logger.LogInformation("에이전트 업데이트 명령 전송: {Dispatched}/{Requested}", dispatched, targetList.Count);
        return new AgentUpdateResultView(targetList.Count, dispatched, null);
    }

    /// <summary>서버 자가 업데이트를 시작한다. 이미 진행 중이거나 자산이 없으면 false.</summary>
    public bool TryStartServerUpdate(out string? error)
    {
        error = null;
        string assetUrl;
        lock (_lock)
        {
            if (_serverPhase is UpdatePhase.Downloading or UpdatePhase.Installing or UpdatePhase.Restarting)
            {
                error = "이미 업데이트가 진행 중입니다.";
                return false;
            }
            if (_latest is null || _latest.Version <= CurrentVersion)
            {
                error = "설치할 새 버전이 없습니다.";
                return false;
            }
            if (_latest.ServerAssetUrl is null)
            {
                error = "릴리스에 서버 설치 파일이 없습니다.";
                return false;
            }
            assetUrl = _latest.ServerAssetUrl;
            _serverPhase = UpdatePhase.Downloading;
            _serverError = null;
        }

        _ = RunServerUpdateAsync(assetUrl);
        _ = _dashboard.Clients.All.UpdateStatusChanged(GetStatus());
        return true;
    }

    private async Task RunServerUpdateAsync(string assetUrl)
    {
        var workDir = Path.Combine(_paths.DataDirectory, "update", Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(workDir);
            var zipPath = Path.Combine(workDir, "server.zip");

            _logger.LogInformation("서버 업데이트 다운로드: {Url}", assetUrl);
            await using (var download = await _http.GetStreamAsync(assetUrl))
            await using (var file = new FileStream(zipPath, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                await download.CopyToAsync(file);
            }

            await SetServerPhaseAsync(UpdatePhase.Installing, null);
            var extractDir = Path.Combine(workDir, "extracted");
            ZipFile.ExtractToDirectory(zipPath, extractDir);

            var installer = Directory.EnumerateFiles(extractDir, "install-server.ps1", SearchOption.AllDirectories).FirstOrDefault()
                ?? throw new InvalidOperationException("설치 스크립트를 찾을 수 없습니다.");

            // 설치기는 서비스를 멈췄다 다시 시작하므로, 이 프로세스와 독립적으로 실행한다.
            // 서버 서비스는 LocalSystem으로 실행되어 설치기가 관리자 권한을 갖는다.
            var startInfo = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(installer)!,
            };
            startInfo.ArgumentList.Add("-NoProfile");
            startInfo.ArgumentList.Add("-ExecutionPolicy");
            startInfo.ArgumentList.Add("Bypass");
            startInfo.ArgumentList.Add("-File");
            startInfo.ArgumentList.Add(installer);

            await SetServerPhaseAsync(UpdatePhase.Restarting, null);
            _logger.LogInformation("서버 설치기 실행: {Installer} (곧 서비스가 재시작됩니다)", installer);
            Process.Start(startInfo);
            // 여기서 반환하면 곧 설치기가 이 서비스를 멈춘다. 새 버전이 다시 시작한다.
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "서버 자가 업데이트 실패");
            await SetServerPhaseAsync(UpdatePhase.Failed, ex.Message);
            try
            {
                Directory.Delete(workDir, recursive: true);
            }
            catch (IOException)
            {
                // 정리 실패는 무시
            }
        }
    }

    private async Task SetServerPhaseAsync(UpdatePhase phase, string? error)
    {
        lock (_lock)
        {
            _serverPhase = phase;
            _serverError = error;
        }
        await _dashboard.Clients.All.UpdateStatusChanged(GetStatus());
    }

    private static bool IsOlder(string? versionText) =>
        Version.TryParse(versionText, out var v) && NormalizeVersion(v) < CurrentVersion;

    private sealed record ReleaseInfo(Version Version, string Name, string? Notes, string? HtmlUrl, DateTime? PublishedAt, string? ServerAssetUrl)
    {
        public static ReleaseInfo? From(GitHubRelease release)
        {
            if (!TryParseTag(release.TagName, out var version))
                return null;
            var asset = release.Assets?.FirstOrDefault(a => a.Name.EndsWith(ServerAssetSuffix, StringComparison.OrdinalIgnoreCase));
            return new ReleaseInfo(
                version,
                (string.IsNullOrWhiteSpace(release.Name) ? release.TagName : release.Name) ?? version.ToString(3),
                release.Body,
                release.HtmlUrl,
                release.PublishedAt,
                asset?.BrowserDownloadUrl);
        }
    }

    private static bool TryParseTag(string? tag, out Version version)
    {
        version = new Version(0, 0, 0);
        if (string.IsNullOrWhiteSpace(tag))
            return false;
        var text = tag.TrimStart('v', 'V');
        if (!Version.TryParse(text, out var parsed))
            return false;
        version = NormalizeVersion(parsed);
        return true;
    }

    private static Version NormalizeVersion(Version? v) =>
        v is null ? new Version(0, 0, 0) : new Version(v.Major, v.Minor, Math.Max(v.Build, 0));

    private sealed record GitHubRelease(
        [property: JsonPropertyName("tag_name")] string? TagName,
        [property: JsonPropertyName("name")] string? Name,
        [property: JsonPropertyName("body")] string? Body,
        [property: JsonPropertyName("html_url")] string? HtmlUrl,
        [property: JsonPropertyName("published_at")] DateTime? PublishedAt,
        [property: JsonPropertyName("assets")] List<GitHubAsset>? Assets);

    private sealed record GitHubAsset(
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("browser_download_url")] string BrowserDownloadUrl);
}
