using System.Diagnostics;
using System.IO.Compression;
using System.Text.RegularExpressions;

namespace PcManager.ServerLauncher;

/// <summary>
/// 서버 바이너리(servers\버전 폴더) 관리: 설치된 버전 확인, GitHub 최신 버전 확인, 서버 zip에서 새 버전 폴더 만들기.
/// 서버 zip(PcManager-Server-버전.zip)은 server\ 아래에 서버·대시보드·에이전트 설치 파일이 들어 있다.
/// </summary>
internal static partial class ServerPackage
{
    public const string Repo = "choisjin/PC_Manager";

    private static readonly HttpClient Http = CreateHttp();

    private static HttpClient CreateHttp()
    {
        var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = Timeout.InfiniteTimeSpan };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("PcManager-ServerLauncher");
        return http;
    }

    private static string NewDirectory => Path.Combine(LauncherPaths.ServersDirectory, "_new");
    private static string DownloadDirectory => Path.Combine(LauncherPaths.Root, "download");

    private static List<ServerBuild>? _builds;

    /// <summary>설치된 서버 버전들 (servers\버전 + 예전 server 폴더). 같은 버전이면 servers 쪽</summary>
    public static IReadOnlyList<ServerBuild> InstalledBuilds()
    {
        if (_builds is not null)
            return _builds;
        var dirs = Directory.Exists(LauncherPaths.ServersDirectory)
            ? Directory.GetDirectories(LauncherPaths.ServersDirectory).Where(d => !Path.GetFileName(d).StartsWith('_')).ToList()
            : [];
        dirs.Add(LauncherPaths.LegacyServerDirectory);
        _builds = dirs
            .Select(d => ReadVersion(d) is { } v ? new ServerBuild(v, d) : null)
            .OfType<ServerBuild>()
            .DistinctBy(b => b.Version)
            .OrderByDescending(b => b.Version)
            .ToList();
        return _builds;
    }

    public static ServerBuild? LatestBuild() => InstalledBuilds().FirstOrDefault();

    public static ServerBuild? FindBuild(string? version) =>
        Version.TryParse(version, out var v) ? InstalledBuilds().FirstOrDefault(b => b.Version == Normalize(v)) : null;

    /// <summary>설치된 최신 서버 버전. 없으면 null</summary>
    public static Version? InstalledVersion() => LatestBuild()?.Version;

    private static Version? ReadVersion(string directory)
    {
        var dll = Path.Combine(directory, "PcManager.Server.dll");
        if (!File.Exists(dll) || !File.Exists(Path.Combine(directory, "PcManager.Server.exe")))
            return null;
        return Version.TryParse(FileVersionInfo.GetVersionInfo(dll).FileVersion, out var v) ? Normalize(v) : null;
    }

    private static Version Normalize(Version v) => new(v.Major, v.Minor, Math.Max(v.Build, 0));

    /// <summary>
    /// 최신 릴리스 버전. API 요청 한도(같은 IP에서 시간당 60회, 사무실 공용)를 쓰지 않도록
    /// /releases/latest 웹 주소의 리디렉션(…/tag/v1.2.3)으로 알아낸다
    /// </summary>
    public static async Task<Version> LatestVersionAsync(CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(TimeSpan.FromSeconds(15));
        using var response = await Http.GetAsync($"https://github.com/{Repo}/releases/latest", HttpCompletionOption.ResponseHeadersRead, cts.Token);
        var location = response.Headers.Location?.ToString() ?? "";
        var match = TagRegex().Match(location);
        if (!match.Success || !Version.TryParse(match.Groups[1].Value, out var version))
            throw new InvalidOperationException($"최신 버전을 확인하지 못했습니다 (HTTP {(int)response.StatusCode})");
        return version;
    }

    /// <summary>GitHub에서 서버 zip을 받는다. 진행률은 0~1</summary>
    public static async Task<string> DownloadAsync(Version version, IProgress<double> progress, CancellationToken ct)
    {
        var v = version.ToString(3);
        var url = $"https://github.com/{Repo}/releases/download/v{v}/PcManager-Server-{v}.zip";
        Directory.CreateDirectory(DownloadDirectory);
        var path = Path.Combine(DownloadDirectory, $"PcManager-Server-{v}.zip");

        // 릴리스 파일은 다른 호스트로 리디렉션된다 (자동 리디렉션을 껐으므로 직접 따라감)
        var target = new Uri(url);
        for (var hop = 0; hop < 5; hop++)
        {
            using var response = await Http.GetAsync(target, HttpCompletionOption.ResponseHeadersRead, ct);
            if (response.Headers.Location is { } next && (int)response.StatusCode is >= 300 and < 400)
            {
                target = next.IsAbsoluteUri ? next : new Uri(target, next);
                continue;
            }
            if (!response.IsSuccessStatusCode)
                throw new InvalidOperationException($"다운로드 실패 (HTTP {(int)response.StatusCode}): {url}");

            var total = response.Content.Headers.ContentLength;
            await using var source = await response.Content.ReadAsStreamAsync(ct);
            await using var file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None);
            var buffer = new byte[81920];
            long done = 0;
            int read;
            while ((read = await source.ReadAsync(buffer, ct)) > 0)
            {
                await file.WriteAsync(buffer.AsMemory(0, read), ct);
                done += read;
                if (total > 0)
                    progress.Report((double)done / total.Value);
            }
            return path;
        }
        throw new InvalidOperationException("리디렉션이 너무 많습니다: " + url);
    }

    /// <summary>zip의 server 폴더를 servers\_new에 푼다. 풀린 서버 버전을 돌려준다</summary>
    public static Version Extract(string zipPath)
    {
        if (Directory.Exists(NewDirectory))
            Directory.Delete(NewDirectory, recursive: true);
        Directory.CreateDirectory(NewDirectory);
        var root = Path.GetFullPath(NewDirectory) + Path.DirectorySeparatorChar;

        using (var zip = ZipFile.OpenRead(zipPath))
        {
            foreach (var entry in zip.Entries)
            {
                // Windows PowerShell의 Compress-Archive는 구분자로 \를 쓰기도 한다
                var name = entry.FullName.Replace('\\', '/');
                if (!name.StartsWith("server/", StringComparison.OrdinalIgnoreCase))
                    continue;
                var relative = name["server/".Length..];
                if (relative.Length == 0)
                    continue;
                var dest = Path.GetFullPath(Path.Combine(NewDirectory, relative));
                if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                    continue;
                if (name.EndsWith('/'))
                {
                    Directory.CreateDirectory(dest);
                    continue;
                }
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                entry.ExtractToFile(dest, overwrite: true);
            }
        }

        if (ReadVersion(NewDirectory) is not { } version)
        {
            Directory.Delete(NewDirectory, recursive: true);
            throw new InvalidOperationException("zip 안에 서버(server\\PcManager.Server.exe)가 없거나 버전을 읽지 못했습니다. PcManager-Server-버전.zip 파일인지 확인하세요.");
        }
        return version;
    }

    /// <summary>
    /// servers\_new를 servers\버전으로 옮긴다. 실행 중인 서버는 자기 버전 폴더를 쓰므로 멈추지 않아도 된다.
    /// 같은 버전 폴더가 이미 있으면 그대로 쓴다 (실행 중일 수 있어 지우다 말면 그 서버가 망가진다)
    /// </summary>
    public static ServerBuild Commit()
    {
        var version = ReadVersion(NewDirectory) ?? throw new InvalidOperationException("풀어 둔 서버가 없습니다.");
        var target = Path.Combine(LauncherPaths.ServersDirectory, version.ToString(3));
        if (ReadVersion(target) == version)
        {
            TryDelete(NewDirectory);
        }
        else
        {
            if (Directory.Exists(target))
                Directory.Delete(target, recursive: true);
            Directory.Move(NewDirectory, target);
        }
        _builds = null;
        return new ServerBuild(version, target);
    }

    /// <summary>최신 버전과 keep(인스턴스가 정했거나 실행 중인 폴더)이 아닌 버전 폴더를 지운다. 잠긴 폴더는 다음에 다시</summary>
    public static void Cleanup(IEnumerable<string> keep)
    {
        var keepSet = keep.Select(Path.GetFullPath).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var latest = LatestBuild();
        foreach (var build in InstalledBuilds())
        {
            if (build == latest || keepSet.Contains(Path.GetFullPath(build.Directory)))
                continue;
            TryDelete(build.Directory);
        }
        foreach (var leftover in new[] { LauncherPaths.LegacyServerDirectory + ".old", LauncherPaths.LegacyServerDirectory + ".new" })
            TryDelete(leftover);
        _builds = null;
    }

    private static void TryDelete(string directory)
    {
        try
        {
            if (Directory.Exists(directory))
                Directory.Delete(directory, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    public static void CleanupDownloads()
    {
        try
        {
            if (Directory.Exists(DownloadDirectory))
                Directory.Delete(DownloadDirectory, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    [GeneratedRegex(@"/tag/v?([0-9]+(?:\.[0-9]+)+)$")]
    private static partial Regex TagRegex();
}

/// <summary>설치된 서버 한 버전 (폴더)</summary>
internal sealed record ServerBuild(Version Version, string Directory)
{
    public string Exe => Path.Combine(Directory, "PcManager.Server.exe");
}
