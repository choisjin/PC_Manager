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
        if (!string.IsNullOrWhiteSpace(_options.GitHubToken))
            _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _options.GitHubToken.Trim());

        // API가 막혔을 때 쓰는 웹 확인: 리디렉션을 따라가지 않고 Location에서 태그를 읽는다
        _web = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(30) };
        _web.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("PcManagerServer", CurrentVersion.ToString(3)));
        ReportPreviousUpdate();
    }

    // 서버 자가 업데이트 직전에 남기는 표시. 다시 시작했을 때 버전이 그대로면 실패로 알린다
    private string PendingMarkerPath => Path.Combine(_paths.DataDirectory, "update", "pending.json");

    private static string InstallLogPath => Path.Combine(Path.GetDirectoryName(ServerOptions.InstalledConfigPath)!, "install.log");

    // JSON으로 저장·읽기: 난독화하면 생성자 매개변수 이름이 지워져 읽지 못하므로 제외
    [System.Reflection.Obfuscation(Exclude = true, ApplyToMembers = true)]
    private sealed record PendingUpdate(string TargetVersion, DateTime StartedAt);

    /// <summary>
    /// 설치기는 곧 이 서비스를 멈춰야 한다. 3분이 지나도 계속 실행 중이면 설치기가 실패한 것이므로
    /// '재시작 중'에 멈춰 있지 않게 실패와 설치 기록 끝부분을 대시보드에 알린다.
    /// </summary>
    private async Task WatchInstallerAsync()
    {
        await Task.Delay(TimeSpan.FromMinutes(3));
        if (_serverPhase != UpdatePhase.Restarting)
            return;
        try { File.Delete(PendingMarkerPath); } catch (IOException) { }
        var tail = ReadInstallLogTail();
        await SetServerPhaseAsync(UpdatePhase.Failed,
            "설치 스크립트가 서버를 다시 시작하지 못했습니다 (3분 경과)."
            + (tail.Length > 0 ? $" 설치 기록: {tail}" : " 설치 기록이 없습니다 — 스크립트가 실행되지 않았을 수 있습니다.")
            + $" 서버 PC에서 install-server.ps1을 직접 실행하세요. (기록: {InstallLogPath})");
    }

    private static string ReadInstallLogTail()
    {
        try
        {
            if (!File.Exists(InstallLogPath))
                return "";
            var lines = File.ReadAllLines(InstallLogPath)
                .Where(l => !string.IsNullOrWhiteSpace(l) && !l.StartsWith("**", StringComparison.Ordinal))
                .TakeLast(4);
            return string.Join(" / ", lines);
        }
        catch (IOException)
        {
            return "";
        }
    }

    /// <summary>이전 자가 업데이트 결과를 확인한다: 새 버전으로 떴으면 성공, 아니면 설치 기록 끝부분과 함께 실패로 표시</summary>
    private void ReportPreviousUpdate()
    {
        try
        {
            if (!File.Exists(PendingMarkerPath))
                return;
            var pending = JsonSerializer.Deserialize<PendingUpdate>(File.ReadAllText(PendingMarkerPath), Json);
            File.Delete(PendingMarkerPath);
            if (pending is null || !TryParseTag(pending.TargetVersion, out var target) || CurrentVersion >= target)
            {
                _logger.LogInformation("서버 업데이트 완료: {Version}", CurrentVersion.ToString(3));
                return;
            }

            var tail = ReadInstallLogTail();
            _serverPhase = UpdatePhase.Failed;
            _serverError = $"{pending.TargetVersion} 설치에 실패해 {CurrentVersion.ToString(3)}(으)로 다시 시작했습니다."
                + (tail.Length > 0 ? $" 설치 기록: {tail}" : "")
                + $" (서버 PC의 {InstallLogPath})";
            _logger.LogWarning("서버 업데이트 실패: {Error}", _serverError);
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            _logger.LogWarning("이전 업데이트 결과 확인 실패: {Message}", ex.Message);
        }
    }

    private readonly HttpClient _web;

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
            ReleaseInfo? info;
            if (response.StatusCode is System.Net.HttpStatusCode.Forbidden or System.Net.HttpStatusCode.TooManyRequests)
            {
                // GitHub API 요청 한도 초과(로그인 없이 IP당 시간 60회) → 웹 주소로 확인
                _logger.LogInformation("GitHub API 요청 한도 초과 → 웹 주소로 최신 버전 확인");
                info = await CheckViaWebAsync(ct);
            }
            else
            {
                response.EnsureSuccessStatusCode();
                await using var stream = await response.Content.ReadAsStreamAsync(ct);
                var release = await JsonSerializer.DeserializeAsync<GitHubRelease>(stream, Json, ct)
                    ?? throw new InvalidOperationException("릴리스 응답이 비었습니다.");
                info = ReleaseInfo.From(release);
            }
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

    /// <summary>
    /// API 없이 최신 릴리스 확인: github.com/{repo}/releases/latest 가 /releases/tag/v1.2.3 으로 리디렉션되는 것을 이용한다.
    /// 릴리스 노트는 못 받으므로 같은 버전을 이미 알고 있으면 그 노트를 쓴다. 서버 설치 파일 주소는 이름 규칙으로 만든다.
    /// </summary>
    private async Task<ReleaseInfo?> CheckViaWebAsync(CancellationToken ct)
    {
        using var response = await _web.GetAsync($"https://github.com/{_options.UpdateRepo}/releases/latest", ct);
        var location = response.Headers.Location?.ToString();
        if (location is null || !location.Contains("/releases/tag/", StringComparison.Ordinal))
            throw new InvalidOperationException($"GitHub API 요청 한도 초과, 웹 확인도 실패 ({(int)response.StatusCode}). 잠시 뒤 다시 확인하세요.");
        var tag = Uri.UnescapeDataString(location[(location.LastIndexOf('/') + 1)..]);
        if (!TryParseTag(tag, out var version))
            return null;

        ReleaseInfo? known;
        lock (_lock)
        {
            known = _latest;
        }
        if (known is not null && known.Version == version)
            return known;
        var htmlUrl = location.StartsWith("http", StringComparison.Ordinal) ? location : $"https://github.com{location}";
        var serverAsset = $"https://github.com/{_options.UpdateRepo}/releases/download/{tag}/PcManager-Server-{version.ToString(3)}{ServerAssetSuffix}";
        return new ReleaseInfo(version, tag, "(GitHub API 요청 한도 때문에 릴리스 노트를 가져오지 못했습니다. 릴리스 페이지에서 확인하세요.)",
            htmlUrl, null, serverAsset);
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

            // 설치기는 이 서비스를 멈췄다 다시 시작하므로, 부모(이 서비스)와 완전히 분리해 실행한다.
            // 그래야 서비스가 멈춘 뒤에도 설치기가 살아남아 파일 교체·재시작을 끝낼 수 있다.
            // 서버 서비스는 LocalSystem으로 실행되어 설치기가 관리자 권한을 갖는다.
            var powershell = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");

            await SetServerPhaseAsync(UpdatePhase.Restarting, null);
            string target;
            lock (_lock)
            {
                target = _latest?.Version.ToString(3) ?? "";
            }
            await File.WriteAllTextAsync(PendingMarkerPath, JsonSerializer.Serialize(new PendingUpdate(target, DateTime.UtcNow), Json));
            _logger.LogInformation("서버 설치기 실행: {Installer} (곧 서비스가 재시작됩니다)", installer);
            DetachedProcess.Start(powershell, $"-NoProfile -ExecutionPolicy Bypass -File \"{installer}\"", Path.GetDirectoryName(installer));
            _ = WatchInstallerAsync();
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

    // JSON으로 저장·읽기: 난독화하면 생성자 매개변수 이름이 지워져 읽지 못하므로 제외
    [System.Reflection.Obfuscation(Exclude = true, ApplyToMembers = true)]
    private sealed record GitHubRelease(
        [property: JsonPropertyName("tag_name")] string? TagName,
        [property: JsonPropertyName("name")] string? Name,
        [property: JsonPropertyName("body")] string? Body,
        [property: JsonPropertyName("html_url")] string? HtmlUrl,
        [property: JsonPropertyName("published_at")] DateTime? PublishedAt,
        [property: JsonPropertyName("assets")] List<GitHubAsset>? Assets);

    // JSON으로 저장·읽기: 난독화하면 생성자 매개변수 이름이 지워져 읽지 못하므로 제외
    [System.Reflection.Obfuscation(Exclude = true, ApplyToMembers = true)]
    private sealed record GitHubAsset(
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("browser_download_url")] string BrowserDownloadUrl);
}
